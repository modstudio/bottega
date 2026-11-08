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

/** Read the newest finished worker-check execution attached to one run. */
export function latestFinishedWorkerCheckExecutionRecordId(
  runRecordId: string,
  database: Database,
): string | null {
  const row = database
    .query<{ record_id: string }, [string]>(
      `SELECT record_id FROM gate_execution
       WHERE run_record_id=? AND purpose='worker-check' AND finished_at IS NOT NULL
       ORDER BY requested_at DESC,record_id DESC LIMIT 1`,
    )
    .get(runRecordId)
  return row?.record_id ?? null
}
