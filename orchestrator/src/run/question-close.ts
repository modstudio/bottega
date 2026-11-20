// concern: question-close
/** Knows when and how an unanswered question is closed. Must not know CLI grammar. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, nowIso, sessionId } from '../database/db.ts'
import {
  mutateQuestion,
  requireQuestionMutationApplied,
} from '../question-store/question-store-mutation.ts'
import { questionById } from '../question-store/question-store-read.ts'
import { runQuestionOwnerLive } from '../question-store/run-question-write-guard.ts'
import type { TaskFlowQuestionCloseRow } from '../workflow/task-flow-store-types.ts'
import { appendQuestionDeliveries } from './question-delivery.ts'
import {
  clearQuestionDeliveryPending,
  pendingDeliveryRunIds,
  pendingQuestionIds,
} from './question-delivery-pending.ts'
import { openChainQuestions, questionsForRunChain } from './question-open.ts'
import { runRootRecord } from './run-root-record.ts'
export const QUESTION_CLOSE_CHAIN_STOPPED = 'chain-stopped'
export const QUESTION_CLOSE_CHAIN_VOIDED = 'chain-voided'
export const QUESTION_CLOSE_CHAIN_STALE = 'chain-stale'
export const QUESTION_CLOSE_ATTEMPT_FAILED_OVER = 'attempt-failed-over'
export const QUESTION_CLOSE_CHAIN_TERMINAL = 'chain-terminal'
const QUESTION_CLOSE_OPERATOR = 'operator-closed'

export type QuestionCloseReason =
  | typeof QUESTION_CLOSE_CHAIN_STOPPED
  | typeof QUESTION_CLOSE_CHAIN_VOIDED
  | typeof QUESTION_CLOSE_CHAIN_STALE
  | typeof QUESTION_CLOSE_ATTEMPT_FAILED_OVER
  | typeof QUESTION_CLOSE_CHAIN_TERMINAL
  | `${typeof QUESTION_CLOSE_OPERATOR}: ${string}`
  | 'advanced-without-ruling'
  | 'abandoned'

async function questionIdsForRunChain(database: Database, rootId: string): Promise<string[]> {
  return (await openChainQuestions<Record<string, unknown>>(database, rootId))
    .sort((a, b) => Number(a.number) - Number(b.number))
    .map((row) => String(row.record_id))
}

export async function closeQuestions(
  database: Database,
  questionIds: readonly string[],
  reason: QuestionCloseReason,
  actor: string | null = sessionId(),
  at: string = nowIso(),
): Promise<number> {
  let closed = 0
  for (const questionId of questionIds) {
    const row = await questionById(database, questionId)
    if (!row || row.answered_at !== null || row.closed_at !== null) continue
    const mutation = await mutateQuestion(database, {
      id: questionId,
      intent: 'close',
      at,
      actorSession: actor,
      reason,
      requireOpen: true,
      changes: { closedAt: at, closeReason: reason },
    })
    if (mutation.applied) closed += 1
  }
  return closed
}

export async function closeRunChainQuestions(
  database: Database,
  rootId: string,
  reason: QuestionCloseReason,
): Promise<number> {
  const closed = await closeQuestions(
    database,
    await questionIdsForRunChain(database, rootId),
    reason,
  )
  await retireRunChainQuestionDeliveries(database, rootId, reason)
  return closed
}

/**
 * Names the chain roots that still hold a pending ruling delivery on this
 * machine. Retirement does nothing for any other chain, so a sweep asks only
 * these; the pending marker carries its run, so this reads nothing hosted.
 */
export function rootsWithPendingDelivery(database: Database): string[] {
  const roots = pendingDeliveryRunIds(database).map(
    (runId) => runRootRecord(runId, database)?.rootRunId ?? runId,
  )
  return [...new Set(roots)]
}

/** Retires rulings that can no longer be delivered because their chain has ended. */
export async function retireRunChainQuestionDeliveries(
  database: Database,
  rootId: string,
  reason: QuestionCloseReason,
  at: string = nowIso(),
): Promise<number> {
  const live = database
    .query(
      `SELECT 1 FROM run
       WHERE (record_id=? OR parent_run_record_id=?) AND status IN ('running','asking')
       LIMIT 1`,
    )
    .get(rootId, rootId)
  if (live) return 0
  const rows = await questionsForRunChain(database, rootId)
  const answeredIds = rows
    .filter((row) => row.answered_at !== null)
    .map((row) => String(row.record_id))
  const questionIds = pendingQuestionIds(database, { questionIds: answeredIds })
  let retired = 0
  for (const questionId of questionIds) {
    if (clearQuestionDeliveryPending(database, [questionId]) !== 1) continue
    const row = await questionById(database, questionId)
    if (!row) throw new Error(`question ${questionId} not found`)
    const mutation = await mutateQuestion(database, {
      id: questionId,
      intent: 'link',
      at,
      actorSession: sessionId(),
      reason,
      changes: {},
    })
    requireQuestionMutationApplied(mutation, row)
    appendQuestionDeliveries(
      [questionId],
      {
        runId: null,
        mode: 'record-only',
        outcome: 'retired',
        at,
        error: reason,
      },
      database,
    )
    retired += 1
  }
  return retired
}

export async function closeQuestionByOperator(
  questionId: string,
  reasonText: string,
  database: Database = db(),
): Promise<void> {
  const text = reasonText.trim()
  if (!text) throw new Error('--reason must not be empty')
  const row = (await questionById(database, questionId)) as
    | (TaskFlowQuestionCloseRow & { owner_status: string | null })
    | null
  if (!row) throw new Error(`no question ${questionId}`)
  if (row.answered_at) throw new Error(`question ${questionId} is already answered`)
  if (row.closed_at) throw new Error(`question ${questionId} is already closed`)
  if (row.workflow_cursor_record_id !== null && row.cursor_state === 'awaiting-ruling') {
    throw new Error(
      `question ${questionId} belongs to a workflow awaiting a ruling; use ${PLATFORM_SLUG} workflow rule or ${PLATFORM_SLUG} workflow abandon`,
    )
  }
  if (
    row.run_record_id !== null &&
    // Close asks: is this question's own owner waiting on it?
    runQuestionOwnerLive(row.owner_status)
  ) {
    throw new Error(
      `question ${questionId}'s owner is waiting; use ${PLATFORM_SLUG} question answer ${row.root_id}`,
    )
  }
  if ((await closeQuestions(database, [questionId], `${QUESTION_CLOSE_OPERATOR}: ${text}`)) !== 1) {
    throw new Error(`question ${questionId} is no longer open`)
  }
}
