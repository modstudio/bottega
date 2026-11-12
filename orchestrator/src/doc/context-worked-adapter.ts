// concern: context-worked-adapter
/** Gathers session work rows and persists their compact fact through the context service. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { questionTaskHolderSql } from '../run/question-open.ts'
import { setContextItem, taskContextItems } from './context-service.ts'
import {
  renderWorkedTaskKeys,
  type WorkedTaskFacts,
  type WorkedTaskRow,
  workedTaskKeys,
} from './context-worked.ts'
import { resolveContextTask } from './context-write-adapter.ts'
import { CONTEXT_ITEM_MAX_CHARS } from './doc-context-write.ts'

function workedTaskFacts(session: string, database: Database = db()): WorkedTaskFacts {
  const runs = database
    .query<WorkedTaskRow, [string]>(
      'SELECT launch_key key,started_at at FROM run WHERE session_id=? AND launch_key IS NOT NULL',
    )
    .all(session)
  const cursors = database
    .query<WorkedTaskRow, [string]>(
      "SELECT workflow_key key,updated_at at FROM workflow_cursor WHERE session_id=? AND workflow_key<>''",
    )
    .all(session)
  const claims = database
    .query<WorkedTaskRow, [string]>(
      `SELECT subject_value key,COALESCE(closed_at,renewed_at,taken_at) at
         FROM board_claim
        WHERE holder_session=? AND subject_kind='task'`,
    )
    .all(session)
  const questions = database
    .query<WorkedTaskRow, [string, string]>(
      `SELECT ${questionTaskHolderSql('q', 'r')} key,q.answered_at at
         FROM question q LEFT JOIN run r ON r.record_id=q.run_record_id
        WHERE q.answered_by IN (?,?) AND q.answered_at IS NOT NULL`,
    )
    .all(session, `operator via ${session}`)
  return { runs, cursors, claims, questions }
}

export function sessionWorkedTaskKeys(session: string, database: Database = db()): string[] {
  return workedTaskKeys(workedTaskFacts(session, database))
}

export async function recordSessionWorked(
  session: string,
  database: Database = db(),
): Promise<{ keys: string[]; body: string | null }> {
  const keys = sessionWorkedTaskKeys(session, database)
  const body = renderWorkedTaskKeys(keys, CONTEXT_ITEM_MAX_CHARS.fact)
  if (body)
    await setContextItem({
      session,
      id: 'worked',
      kind: 'fact',
      source: 'precompact',
      body,
    })
  return { keys, body }
}

/** Best-effort close-out report: unreadable task mirrors do not make close-out refuse. */
export async function tasksWithoutNextAction(
  keys: readonly string[],
  database: Database = db(),
): Promise<string[]> {
  const missing: string[] = []
  for (const key of keys) {
    try {
      const task = await resolveContextTask(key, database)
      if (!taskContextItems(task, database).some((item) => item.kind === 'next-action'))
        missing.push(key)
    } catch {}
  }
  return missing
}
