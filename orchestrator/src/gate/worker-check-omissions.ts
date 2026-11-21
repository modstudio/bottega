// concern: lightweight persisted worker-check omission readers

import type { Database } from 'bun:sqlite'

/** Read every persisted omission for one gate execution in presentation order. */
export function uncheckedChecksForGateExecution(
  executionRecordId: string,
  database: Database,
): readonly { check: string; reason: string }[] {
  return database
    .query<{ check: string; reason: string }, [string]>(
      `SELECT check_name AS "check",unchecked_reason AS reason
       FROM check_execution
       WHERE gate_execution_record_id=? AND unchecked_reason IS NOT NULL
       ORDER BY check_name,record_id`,
    )
    .all(executionRecordId)
}
