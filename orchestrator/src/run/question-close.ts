// concern: question-close
/** Knows when and how an unanswered question is closed. Must not know CLI grammar. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, nowIso, sessionId } from '../database/db.ts'
import {
  mutateQuestion,
  requireQuestionMutationApplied,
} from '../question-store/question-store-mutation.ts'
import { questionById, questionsById } from '../question-store/question-store-read.ts'
import type { TaskFlowQuestionCloseRow } from '../workflow/task-flow-store-types.ts'
import { appendQuestionDeliveries } from './question-delivery.ts'
import { clearQuestionDeliveryPending, pendingQuestionIds } from './question-delivery-pending.ts'
import { openChainQuestions, questionsForRunChain } from './question-open.ts'
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
 * these instead of reading every chain's questions from the record.
 */
export async function rootsWithPendingDelivery(database: Database): Promise<string[]> {
  const pending = pendingQuestionIds(database, {})
  const roots = new Set<string>()
  for (let offset = 0; offset < pending.length; offset += 100) {
    for (const row of await questionsById(database, pending.slice(offset, offset + 100))) {
      const runId = typeof row.run_record_id === 'string' ? row.run_record_id : null
      if (!runId) continue
      const local = database
        .query<{ root: string }, [string]>(
          'SELECT COALESCE(parent_run_record_id,record_id) root FROM run WHERE record_id=?',
        )
        .get(runId)
      roots.add(local?.root ?? runId)
    }
  }
  return [...roots]
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
  const row = (await questionById(database, questionId)) as TaskFlowQuestionCloseRow | null
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
    (row.latest_status === 'running' || row.latest_status === 'asking')
  ) {
    throw new Error(
      `question ${questionId}'s chain is live; use ${PLATFORM_SLUG} question answer ${row.root_id}`,
    )
  }
  if ((await closeQuestions(database, [questionId], `${QUESTION_CLOSE_OPERATOR}: ${text}`)) !== 1) {
    throw new Error(`question ${questionId} is no longer open`)
  }
}
