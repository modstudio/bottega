// concern: note relink record
/** Prepares a hosted relink trail, then applies its accepted rows to the local mirror. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import type { PushedComment } from './push-contract.ts'
import type { TaskRow } from './task-row.ts'

function localTask(conn: Database, key: string, project: string): TaskRow {
  const upper = key.toUpperCase()
  const task = conn
    .query<TaskRow, [string, string]>(
      `SELECT * FROM task WHERE project=? AND key=? COLLATE NOCASE`,
    )
    .get(project, upper)
  if (task?.source !== 'local')
    throw new Error(
      `no local task ${upper} in project ${project}; run \`${PLATFORM_SLUG} task list --project ${project}\``,
    )
  return task
}

export function prepareNoteRelinkComments(
  conn: Database,
  input: {
    project: string
    noteLabel: string
    previousTask: string
    targetTask: string
    reason: string
    at: string
  },
) {
  const target = localTask(conn, input.targetTask, input.project)
  const previous = localTask(conn, input.previousTask, input.project)
  const row = (task: TaskRow, body: string): PushedComment => ({
    id: newRecordId(),
    task_key: task.key,
    task_id: task.record_id,
    project_name: task.project,
    projectId: task.project_record_id,
    body,
    created_at: input.at,
    updated_at: input.at,
    deleted_at: null,
  })
  return {
    targetTaskRecordId: target.record_id,
    comments: [
      row(
        target,
        `note ${input.noteLabel} relinked from ${input.previousTask}: ${input.reason}`,
      ),
      ...(previous.record_id === target.record_id
        ? []
        : [
            row(
              previous,
              `note ${input.noteLabel} relinked to ${target.key}: ${input.reason}`,
            ),
          ]),
    ],
  }
}

export function recordPreparedNoteRelinkComments(
  conn: Database,
  comments: readonly PushedComment[],
): void {
  for (const comment of comments) {
    conn
      .query(
        `INSERT INTO task_comment
         (record_id,task_key,task_record_id,body,created_at,updated_at,
          actor_user_id,actor_name,agent,run_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        comment.id,
        comment.task_key,
        comment.task_id,
        comment.body,
        comment.created_at,
        comment.updated_at,
        comment.actor_user_id,
        comment.actor_name,
        comment.agent,
        comment.run_id,
      )
    conn
      .query(`UPDATE task SET updated_at=?,last_seen=? WHERE record_id=?`)
      .run(comment.updated_at, comment.updated_at, comment.task_id)
  }
}
