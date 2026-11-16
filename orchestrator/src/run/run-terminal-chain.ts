// concern: terminal chain finalization
/** Closes suspension state and rolls a terminal turn outcome into its chain root. */
import type { Database } from 'bun:sqlite'
import { type classify, FAILS_OVER } from '../failure/failure.ts'
import { closeRunChainQuestions, QUESTION_CLOSE_CHAIN_TERMINAL } from './question-close.ts'
import { rollUpRootAndEnqueue } from './run-liveness.ts'

export async function closeTerminalChainQuestions(
  database: Database,
  rootId: string,
  status: string,
  failureKind: ReturnType<typeof classify> | null,
): Promise<void> {
  if (status === 'asking' || status === 'running') return
  if (failureKind && FAILS_OVER.includes(failureKind)) return
  await closeRunChainQuestions(database, rootId, QUESTION_CLOSE_CHAIN_TERMINAL)
}

export function finalizeTerminalChain(
  database: Database,
  input: {
    runId: string
    parentRunId: string | null
    status: string
    failureKind: ReturnType<typeof classify> | null
    error: string | null
    record: [machineId: string, finishedAt: string]
  },
): void {
  if (input.parentRunId !== null && input.status === 'asking') {
    database
      .query(
        `UPDATE run SET status='asking', error=?, failure_kind=NULL
        WHERE record_id=? AND parent_run_record_id IS NULL AND status NOT IN ('stopped', 'stale')`,
      )
      .run(input.error, input.parentRunId)
  }
  if (input.parentRunId !== null) {
    rollUpRootAndEnqueue(database, input.parentRunId, null, ...input.record, false)
  }
}
