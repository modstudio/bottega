import { db } from './db.ts'
import { listLocalTaskDocuments } from './task-document.ts'
import type { TaskDocumentSummary } from './task-document-types.ts'
import { resolveTask, type TaskScope, taskByRecordId, taskRecordId } from './task-identity.ts'
import type { TaskRow } from './task-row.ts'
import type { HostedTaskLookupRow, TaskComment } from './task-types.ts'
import { registeredTaskProject } from './task-write-destination.ts'

export function listLocalTasks(
  filters: { project?: string; status?: string; parent?: string } = {},
): TaskRow[] {
  const clauses: string[] = []
  const values: string[] = []
  if (filters.project) {
    registeredTaskProject(filters.project)
    clauses.push('project = ?')
    values.push(filters.project)
  }
  if (filters.status) {
    clauses.push('status_category = ?')
    values.push(filters.status)
  }
  if (filters.parent) {
    clauses.push('parent_record_id = ?')
    values.push(resolveTask(db(), filters.parent, filters.project))
  }
  return db()
    .query<TaskRow, string[]>(
      `SELECT * FROM task ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY project, key`,
    )
    .all(...values)
}

export function lookupLocalTasks(project: string, keys: string[]): HostedTaskLookupRow[] {
  registeredTaskProject(project)
  const found = new Map<string, HostedTaskLookupRow>()
  let pending = [...new Set(keys.map((key) => key.toUpperCase()))]
  while (pending.length) {
    const placeholders = pending.map(() => '?').join(',')
    const rows = db()
      .query<Omit<HostedTaskLookupRow, 'has_children'>, string[]>(
        `SELECT record_id,key,project,title,parent_key,status,status_category,opened_at,last_seen
         FROM task WHERE project=? AND key IN (${placeholders}) ORDER BY key`,
      )
      .all(project, ...pending)
    pending = []
    for (const row of rows) {
      if (found.has(row.record_id)) continue
      const hasChildren =
        db()
          .query<{ found: number }, [string]>(
            'SELECT 1 found FROM task WHERE parent_record_id=? LIMIT 1',
          )
          .get(row.record_id) !== null
      found.set(row.record_id, { ...row, has_children: hasChildren })
      if (row.parent_key) pending.push(row.parent_key)
    }
  }
  return [...found.values()]
}

export function showLocalTask(
  key: string,
  scope: TaskScope = {},
): { task: TaskRow; comments: TaskComment[]; documents: TaskDocumentSummary[] } {
  const upper = key.toUpperCase()
  const recordId = taskRecordId(upper, scope)
  const task = taskByRecordId<TaskRow>(recordId)
  const comments = db()
    .query<TaskComment, [string]>(
      `SELECT record_id AS id, task_key, task_record_id, body, created_at,updated_at,deleted_at,
       actor_user_id,actor_name,agent,run_id FROM task_comment
       WHERE task_record_id = ? AND deleted_at IS NULL ORDER BY created_at, record_id`,
    )
    .all(recordId)
  return { task, comments, documents: listLocalTaskDocuments(upper, { recordId }) }
}
