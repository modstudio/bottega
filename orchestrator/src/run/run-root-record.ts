// concern: root run ownership
/** Resolves the root run that owns a descendant's sandbox claim. */
import { db } from '../database/db.ts'

export function rootRunRecordId(runId: string): string {
  return (
    db()
      .query('SELECT COALESCE(parent_run_record_id,record_id) root_id FROM run WHERE record_id=?')
      .get(runId) as { root_id: string }
  ).root_id
}
