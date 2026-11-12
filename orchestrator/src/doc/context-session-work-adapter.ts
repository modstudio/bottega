// concern: context-session-work-adapter
/** Gathers the run, closed workflow-step, and answered-question work events of a session. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { questionTaskHolderSql } from '../run/question-open.ts'
import { taskFlowStore } from '../workflow/task-flow-store.ts'
import { type CursorTrailEntry, isClosedStep } from '../workflow/workflow-cursor-trail.ts'

export type SessionWorkEvent = { key: string | null; at: string }

export function sessionWorkEvents(session: string, database: Database = db()): SessionWorkEvent[] {
  const work = database
    .query<SessionWorkEvent, [string]>(
      'SELECT launch_key key,started_at at FROM run WHERE session_id=? AND launch_key IS NOT NULL',
    )
    .all(session)
  for (const row of taskFlowStore(database).cursorWorkForSession(session)) {
    for (const entry of JSON.parse(row.closed) as CursorTrailEntry[])
      if (isClosedStep(entry)) work.push({ key: row.key, at: entry.at })
  }
  work.push(
    ...database
      .query<SessionWorkEvent, [string, string]>(
        `SELECT ${questionTaskHolderSql('q', 'r')} key,q.answered_at at
           FROM question q LEFT JOIN run r ON r.record_id=q.run_record_id
          WHERE q.answered_by IN (?,?) AND q.answered_at IS NOT NULL`,
      )
      .all(session, `operator via ${session}`),
  )
  return work
}
