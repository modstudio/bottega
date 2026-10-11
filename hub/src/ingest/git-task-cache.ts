import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record/schema.ts'
import { queueHostedChange } from '../outbox.ts'
import { HOSTED_TASK_TABLE } from '../push-contract.ts'
import type { TaskRow } from '../task.ts'
import { gitTaskShouldQueue } from '../task-hosted-row.ts'

export type GitTaskObservation = {
  key: string
  project: string
  first: string
  last: string
}

export function upsertGitTasks(
  conn: Database,
  tasks: Iterable<GitTaskObservation>,
  at: string,
): void {
  const select = conn.query<TaskRow, [string, string]>(
    `SELECT * FROM task WHERE project=? AND key=?`,
  )
  const upsert = conn.query(
    `INSERT INTO task (record_id,key, project, source, opened_at, updated_at, first_seen, last_seen)
     VALUES (?,?,?,'git',?,?,?,?)
     ON CONFLICT(project,key) DO UPDATE SET
       record_id = COALESCE(task.record_id, excluded.record_id),
       last_seen  = excluded.last_seen,
       updated_at = MAX(COALESCE(task.updated_at,''), excluded.updated_at),
       opened_at  = CASE
         WHEN task.source != 'git' THEN task.opened_at
         WHEN task.opened_at IS NULL THEN excluded.opened_at
         WHEN excluded.opened_at < task.opened_at THEN excluded.opened_at
         ELSE task.opened_at
       END`,
  )
  for (const task of tasks) {
    const before = select.get(task.project, task.key) ?? null
    upsert.run(newRecordId(), task.key, task.project, task.first, task.last, at, at)
    const after = select.get(task.project, task.key)!
    if (gitTaskShouldQueue(before, after))
      queueHostedChange(conn, HOSTED_TASK_TABLE, after.record_id, 'upsert', at)
  }
}
