// concern: terminal chain finalization
/** Closes suspension state and rolls a terminal turn outcome into its chain root. */
import type { Database } from 'bun:sqlite'
import { type classify, FAILS_OVER } from '../failure/failure.ts'
import { closeRunChainQuestions, QUESTION_CLOSE_CHAIN_TERMINAL } from './question-close.ts'
import { rollUpRootAndEnqueue } from './run-liveness.ts'

export async function closeRunTerminalChainQuestions(
  database: Database,
  rootId: string,
  status: string,
  failureKind: ReturnType<typeof classify> | null,
): Promise<void> {
  if (status === 'asking' || status === 'running') return
  if (failureKind && FAILS_OVER.includes(failureKind)) return
  await closeRunChainQuestions(database, rootId, QUESTION_CLOSE_CHAIN_TERMINAL)
}

export async function settleTerminalQuestionState(input: {
  database: Database
  runId: string
  rootId: string
  preAnswer(): Promise<void>
}): Promise<{ status: string; failure_kind: string | null }> {
  const recordedBeforeQuestions = input.database
    .query('SELECT status, failure_kind FROM run WHERE record_id=?')
    .get(input.runId) as { status: string; failure_kind: ReturnType<typeof classify> | null } | null
  if (!recordedBeforeQuestions)
    throw new Error(`run ${input.runId} disappeared before terminalisation`)
  await closeRunTerminalChainQuestions(
    input.database,
    input.rootId,
    recordedBeforeQuestions.status,
    recordedBeforeQuestions.failure_kind,
  )
  await input.preAnswer()
  const recorded = input.database
    .query('SELECT status, failure_kind FROM run WHERE record_id=?')
    .get(input.runId) as { status: string; failure_kind: string | null } | null
  if (!recorded) throw new Error(`run ${input.runId} disappeared before terminalisation`)
  return recorded
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
