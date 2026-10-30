// concern: terminal chain finalization
/** Closes suspension state and rolls a terminal turn outcome into its chain root. */
import type { Database } from 'bun:sqlite'
import { type classify, FAILS_OVER } from '../failure/failure.ts'
import {
  closeRunChainQuestions,
  QUESTION_CLOSE_CHAIN_TERMINAL,
  retireRunChainQuestionDeliveries,
} from './question-close.ts'
import { rollUpRootAndEnqueue } from './run-liveness.ts'

function closeTerminalQuestions(
  database: Database,
  rootId: string,
  status: string,
  failureKind: ReturnType<typeof classify> | null,
): void {
  if (status === 'asking' || status === 'running') return
  if (failureKind && FAILS_OVER.includes(failureKind)) return
  closeRunChainQuestions(database, rootId, QUESTION_CLOSE_CHAIN_TERMINAL)
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
  const rootId = input.parentRunId ?? input.runId
  if (input.parentRunId !== null && input.status === 'asking') {
    database
      .query(
        `UPDATE run SET status='asking', error=?, failure_kind=NULL
        WHERE record_id=? AND parent_run_record_id IS NULL AND status NOT IN ('stopped', 'stale')`,
      )
      .run(input.error, input.parentRunId)
  }
  closeTerminalQuestions(database, rootId, input.status, input.failureKind)
  if (input.parentRunId !== null) {
    rollUpRootAndEnqueue(database, input.parentRunId, null, ...input.record)
  }
  if (
    input.status !== 'asking' &&
    input.status !== 'running' &&
    !(input.failureKind && FAILS_OVER.includes(input.failureKind))
  ) {
    retireRunChainQuestionDeliveries(database, rootId, QUESTION_CLOSE_CHAIN_TERMINAL)
  }
}
