import { db, nowIso } from './db.ts'
import { projects, type StatusCategory } from './projects.ts'

export const TASK_STATUSES = ['open', 'active', 'review', 'done', 'dropped'] as const

export type TaskRow = {
  key: string
  project: string
  title: string | null
  status: string | null
  status_category: StatusCategory | null
  parent_key: string | null
  body: string | null
  assignee: string | null
  opened_at: string | null
  closed_at: string | null
  updated_at: string | null
  source: 'mcp' | 'git' | 'local'
  first_seen: string
  last_seen: string
}

export type TaskComment = { id: number; task_key: string; body: string; created_at: string }

function status(value: string | undefined): StatusCategory {
  const candidate = value ?? 'open'
  if (!(TASK_STATUSES as readonly string[]).includes(candidate)) {
    throw new Error(`invalid status '${candidate}': expected ${TASK_STATUSES.join('|')}`)
  }
  return candidate as StatusCategory
}

function registeredProject(name: string) {
  const project = projects().find((candidate) => candidate.name === name)
  if (!project) throw new Error(`unknown project '${name}'`)
  return project
}

function assertParent(key: string | null | undefined) {
  if (!key) return
  const found = db().query<{ key: string }, [string]>(`SELECT key FROM task WHERE key = ?`).get(key)
  if (!found) throw new Error(`no task ${key}`)
}

/** Allocate and insert under one IMMEDIATE transaction, serialising concurrent issuers. */
export function createTask(input: {
  project: string; title: string; status?: string; parent?: string; body?: string
}): TaskRow {
  const project = registeredProject(input.project)
  const prefix = project.settings.keyPrefixes?.[0]
  if (!prefix) {
    throw new Error(
      `project '${input.project}' has no key prefix; set one with ` +
      `orch project set ${input.project} --settings '{"keyPrefixes":["ABC"]}'`,
    )
  }
  const category = status(input.status)
  const parent = input.parent?.toUpperCase()
  assertParent(parent)
  const d = db()
  const at = nowIso()
  const issue = d.transaction(() => {
    const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`, 'i')
    const highest = d.query<{ key: string }, []>(`SELECT key FROM task`).all()
      .reduce((max, row) => {
        const match = pattern.exec(row.key)
        return match ? Math.max(max, Number(match[1])) : max
      }, 0)
    const sequence = d.query<{ next: number }, [string]>(
      `SELECT next FROM seq WHERE name = ?`,
    ).get(`task:${prefix}`)
    const number = Math.max(highest + 1, sequence?.next ?? 1)
    const key = `${prefix.toUpperCase()}-${number}`
    d.query(
      `INSERT INTO task (key, project, title, status, status_category, parent_key, body,
                         opened_at, closed_at, updated_at, source, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?)`,
    ).run(key, input.project, input.title, category, category, parent ?? null, input.body ?? null,
          at, category === 'done' ? at : null, at, at, at)
    d.query(
      `INSERT INTO seq (name, next) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET next = excluded.next`,
    ).run(`task:${prefix}`, number + 1)
    return key
  })
  const key = issue.immediate()
  return showTask(key).task
}

export function listTasks(filters: {
  project?: string; status?: string; parent?: string
} = {}): TaskRow[] {
  const clauses: string[] = []
  const values: string[] = []
  if (filters.project) {
    registeredProject(filters.project)
    clauses.push('project = ?'); values.push(filters.project)
  }
  if (filters.status) {
    clauses.push('status_category = ?'); values.push(status(filters.status))
  }
  if (filters.parent) {
    clauses.push('parent_key = ?'); values.push(filters.parent.toUpperCase())
  }
  return db().query<TaskRow, string[]>(
    `SELECT * FROM task ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY project, key`,
  ).all(...values)
}

export function showTask(key: string): { task: TaskRow; comments: TaskComment[] } {
  const upper = key.toUpperCase()
  const task = db().query<TaskRow, [string]>(`SELECT * FROM task WHERE key = ?`).get(upper)
  if (!task) throw new Error(`no task ${upper}`)
  const comments = db().query<TaskComment, [string]>(
    `SELECT id, task_key, body, created_at FROM task_comment
      WHERE task_key = ? ORDER BY created_at, id`,
  ).all(upper)
  return { task, comments }
}

export function setTask(key: string, changes: {
  title?: string; status?: string; parent?: string | null; body?: string
}, options: { force?: boolean } = {}): TaskRow {
  const upper = key.toUpperCase()
  const d = db()
  const write = d.transaction(() => {
    const current = showTask(upper).task
    if (current.source !== 'local') throw new Error(`task ${upper} is not local`)
    if (changes.body !== undefined && current.body !== null && current.body !== '' && !options.force) {
      throw new Error(
        `task ${upper} already has a body:\n\n${current.body}\n\n` +
        'Pass --force to overwrite it.',
      )
    }
    const category = changes.status === undefined ? current.status_category : status(changes.status)
    const parent = changes.parent === undefined
      ? current.parent_key
      : changes.parent?.toUpperCase() ?? null
    assertParent(parent)
    const at = nowIso()
    d.query(
      `UPDATE task SET title = ?, status = ?, status_category = ?, parent_key = ?, body = ?,
                       closed_at = CASE WHEN ? = 'done' THEN COALESCE(closed_at, ?) ELSE NULL END,
                       updated_at = ?, last_seen = ?
        WHERE key = ?`,
    ).run(changes.title ?? current.title, category, category, parent,
          changes.body ?? current.body, category, at, at, at, upper)
    if (changes.status !== undefined && current.status_category !== category) {
      d.query(
        `INSERT OR IGNORE INTO task_status_event (task_key, at, from_status, to_status)
         VALUES (?, ?, ?, ?)`,
      ).run(upper, at, current.status_category, category)
    }
  })
  // The body guard and update share the same write lock, so another setter
  // cannot add a body between the check and the update.
  write.immediate()
  return showTask(upper).task
}

export const closeTask = (key: string) => setTask(key, { status: 'done' })

export function commentTask(key: string, body: string): TaskComment {
  const upper = key.toUpperCase()
  const current = showTask(upper).task
  if (current.source !== 'local') throw new Error(`task ${upper} is not local`)
  const at = nowIso()
  const result = db().query(
    `INSERT INTO task_comment (task_key, body, created_at) VALUES (?, ?, ?)`,
  ).run(upper, body, at)
  db().query(`UPDATE task SET updated_at = ?, last_seen = ? WHERE key = ?`).run(at, at, upper)
  return { id: Number(result.lastInsertRowid), task_key: upper, body, created_at: at }
}
