import { db, nowIso } from './db.ts'
import { projects, type StatusCategory } from './projects.ts'
import { randomBytes } from 'node:crypto'

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

export type DuplicateCandidate = {
  key: string
  status: string | null
  title: string
  score: number
}

const DUPLICATE_STOP_WORDS = new Set(
  'a an and are as at be by for from has have in into is it its of on or that the this to was were will with should before after not no'.split(' '),
)

// Provisional, measured against the real reports that prompted DEV-267:
// DEV-209/DEV-210 scored 0.248, DEV-265/DEV-266 scored 0.227, and the best
// unrelated result across those four searches scored 0.151.
const DUPLICATE_THRESHOLD = 0.20
const DUPLICATE_LIMIT = 3

function titleTokens(title: string): Set<string> {
  return new Set(
    (title.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .filter((token) => token.length > 1 && !DUPLICATE_STOP_WORDS.has(token)),
  )
}

export function duplicateScore(left: string, right: string): number {
  const a = titleTokens(left)
  const b = titleTokens(right)
  if (!a.size || !b.size) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection++
  return intersection / (a.size + b.size - intersection)
}

export function duplicateCandidates(tasks: TaskRow[], title: string): DuplicateCandidate[] {
  return tasks
    .filter((task): task is TaskRow & { title: string } => !!task.title)
    .map((task) => ({
      key: task.key,
      status: task.status,
      title: task.title,
      score: duplicateScore(title, task.title),
    }))
    .filter((candidate) => candidate.score >= DUPLICATE_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, DUPLICATE_LIMIT)
}

export const TASK_DOCUMENT_ROLES = ['handoff'] as const
export type TaskDocumentRole = typeof TASK_DOCUMENT_ROLES[number]
export type TaskDocumentSummary = {
  id: number
  task_key: string
  role: TaskDocumentRole | null
  title: string
  updated_at: string
}
export type TaskDocument = TaskDocumentSummary & {
  body: string
  version: string
  created_at: string
}

const documentVersion = () => randomBytes(8).toString('hex')

function documentRole(value: string | null | undefined): TaskDocumentRole | null {
  if (value == null) return null
  if (!(TASK_DOCUMENT_ROLES as readonly string[]).includes(value)) {
    throw new Error(`invalid document role '${value}': expected ${TASK_DOCUMENT_ROLES.join('|')}`)
  }
  return value as TaskDocumentRole
}

function documentId(value: number | string): number {
  const id = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`invalid document id '${value}'`)
  return id
}

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

export function showTask(key: string): {
  task: TaskRow; comments: TaskComment[]; documents: TaskDocumentSummary[]
} {
  const upper = key.toUpperCase()
  const task = db().query<TaskRow, [string]>(`SELECT * FROM task WHERE key = ?`).get(upper)
  if (!task) throw new Error(`no task ${upper}`)
  const comments = db().query<TaskComment, [string]>(
    `SELECT id, task_key, body, created_at FROM task_comment
      WHERE task_key = ? ORDER BY created_at, id`,
  ).all(upper)
  return { task, comments, documents: listTaskDocuments(upper) }
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

export function listTaskDocuments(key: string): TaskDocumentSummary[] {
  const upper = key.toUpperCase()
  const task = db().query<{ key: string }, [string]>(`SELECT key FROM task WHERE key = ?`).get(upper)
  if (!task) throw new Error(`no task ${upper}`)
  return db().query<TaskDocumentSummary, [string]>(
    `SELECT id, task_key, role, title, updated_at FROM task_document
      WHERE task_key = ? ORDER BY created_at, id`,
  ).all(upper)
}

export function getTaskDocument(idValue: number | string): TaskDocument {
  const id = documentId(idValue)
  const document = db().query<TaskDocument, [number]>(
    `SELECT id, task_key, role, title, body, version, created_at, updated_at
       FROM task_document WHERE id = ?`,
  ).get(id)
  if (!document) throw new Error(`no task document ${id}`)
  return document
}

export function createTaskDocument(input: {
  task: string; title: string; body?: string; role?: string
}): TaskDocument {
  const upper = input.task.toUpperCase()
  const task = showTask(upper).task
  if (task.source !== 'local') throw new Error(`task ${upper} is not local`)
  const at = nowIso()
  const result = db().query(
    `INSERT INTO task_document (task_key, role, title, body, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(upper, documentRole(input.role), input.title, input.body ?? '', documentVersion(), at, at)
  return getTaskDocument(Number(result.lastInsertRowid))
}

export function updateTaskDocument(idValue: number | string, changes: {
  title?: string; body?: string; role?: string | null; expectedVersion?: string
}): TaskDocument {
  const id = documentId(idValue)
  const d = db()
  const write = d.transaction(() => {
    const current = getTaskDocument(id)
    const task = showTask(current.task_key).task
    if (task.source !== 'local') throw new Error(`task ${current.task_key} is not local`)
    const role = changes.role === undefined ? current.role : documentRole(changes.role)
    const at = nowIso()

    if (changes.body !== undefined) {
      if (!changes.expectedVersion) {
        throw new Error('a body update requires --version from `hub task doc show`')
      }
      const result = d.query(
        `UPDATE task_document
            SET title = ?, role = ?, body = ?, version = ?, updated_at = ?
          WHERE id = ? AND version = ?`,
      ).run(changes.title ?? current.title, role, changes.body, documentVersion(), at,
            id, changes.expectedVersion)
      if (result.changes !== 1) {
        throw new Error(`task document ${id} changed since version ${changes.expectedVersion}; read it again`)
      }
    } else {
      d.query(
        `UPDATE task_document SET title = ?, role = ?, updated_at = ? WHERE id = ?`,
      ).run(changes.title ?? current.title, role, at, id)
    }
  })
  write.immediate()
  return getTaskDocument(id)
}

export function deleteTaskDocument(idValue: number | string): TaskDocument {
  const id = documentId(idValue)
  const d = db()
  let removed: TaskDocument | null = null
  const write = d.transaction(() => {
    removed = getTaskDocument(id)
    const task = showTask(removed.task_key).task
    if (task.source !== 'local') throw new Error(`task ${removed.task_key} is not local`)
    d.query(`DELETE FROM task_document WHERE id = ?`).run(id)
  })
  write.immediate()
  return removed!
}
