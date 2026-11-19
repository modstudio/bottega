// concern: record history upload state
/** Owns the schema_meta state shared by history upload and hosted-row release. */

import type { Database } from 'bun:sqlite'

export const WORKFLOW_HISTORY_UPLOAD_FINGERPRINT_KEY = 'record_workflow_history_upload_fingerprint'
const WORKFLOW_HISTORY_HELD_QUESTION_IDS_KEY = 'record_workflow_history_held_question_ids'

export function readHeldQuestionIds(database: Database): Set<string> {
  const row = database
    .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
    .get(WORKFLOW_HISTORY_HELD_QUESTION_IDS_KEY)
  if (!row) return new Set()
  try {
    const ids: unknown = JSON.parse(row.value)
    return new Set(
      Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [],
    )
  } catch {
    return new Set()
  }
}

export function storeHeldQuestionIds(database: Database, ids: ReadonlySet<string>): void {
  database
    .query(
      `INSERT INTO schema_meta(key,value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(WORKFLOW_HISTORY_HELD_QUESTION_IDS_KEY, JSON.stringify([...ids].sort()))
}
