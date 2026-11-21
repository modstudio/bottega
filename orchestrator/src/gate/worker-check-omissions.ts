// concern: lightweight persisted worker-check omission readers

import type { Database } from 'bun:sqlite'

export type FinishedWorkerCheckExecution = {
  record_id: string
  number: number
  head_commit: string | null
  tree_id: string | null
  requested_at: string
  exit_code: number | null
  timed_out: number | null
  output_tail: string | null
  output_artifact: string | null
}

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
export function latestFinishedWorkerCheckExecution(
  runRecordId: string,
  database: Database,
): FinishedWorkerCheckExecution | null {
  const row = database
    .query<FinishedWorkerCheckExecution, [string]>(
      `SELECT record_id,number,head_commit,tree_id,requested_at,exit_code,timed_out,output_tail,output_artifact
       FROM gate_execution
       WHERE run_record_id=? AND purpose='worker-check' AND finished_at IS NOT NULL
         AND cancelled_reason IS NULL
       ORDER BY requested_at DESC,record_id DESC LIMIT 1`,
    )
    .get(runRecordId)
  return row ?? null
}
