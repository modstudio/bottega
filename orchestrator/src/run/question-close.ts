// concern: question-close
/** Knows when and how an unanswered question is closed. Must not know CLI grammar. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, nowIso, sessionId, writeTransaction } from '../database/db.ts'
import { appendQuestionDeliveries } from './question-delivery.ts'
import { auditQuestionMutation } from './question-mutation.ts'
import { questionOpenSql } from './question-open.ts'
import { enqueueQuestionRecord } from './question-outbox.ts'
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

function questionIdsForRunChain(database: Database, rootId: string): string[] {
  return database
    .query<{ record_id: string }, [string, string]>(
      `SELECT q.record_id FROM question q JOIN run owner ON owner.record_id=q.run_record_id
       WHERE (owner.record_id=? OR owner.parent_run_record_id=?) AND ${questionOpenSql('q')}
       ORDER BY q.number`,
    )
    .all(rootId, rootId)
    .map((row) => row.record_id)
}

export function closeQuestions(
  database: Database,
  questionIds: readonly string[],
  reason: QuestionCloseReason,
  actor: string | null = sessionId(),
  at: string = nowIso(),
): number {
  const update = database.query(
    `UPDATE question SET closed_at=?,close_reason=?,revision=revision+1
     WHERE record_id=? AND ${questionOpenSql('question')}`,
  )
  let closed = 0
  for (const questionId of questionIds) {
    if (update.run(at, reason, questionId).changes !== 1) continue
    auditQuestionMutation({ questionId, action: 'close', actor, at, reason }, database)
    enqueueQuestionRecord(database, questionId)
    closed += 1
  }
  return closed
}

export function closeRunChainQuestions(
  database: Database,
  rootId: string,
  reason: QuestionCloseReason,
): number {
  const closed = closeQuestions(database, questionIdsForRunChain(database, rootId), reason)
  retireRunChainQuestionDeliveries(database, rootId, reason)
  return closed
}

/** Retires rulings that can no longer be delivered because their chain has ended. */
export function retireRunChainQuestionDeliveries(
  database: Database,
  rootId: string,
  reason: QuestionCloseReason,
  at: string = nowIso(),
): number {
  const live = database
    .query(
      `SELECT 1 FROM run
       WHERE (record_id=? OR parent_run_record_id=?) AND status IN ('running','asking')
       LIMIT 1`,
    )
    .get(rootId, rootId)
  if (live) return 0
  const questionIds = database
    .query<{ record_id: string }, [string, string]>(
      `SELECT q.record_id FROM question q JOIN run owner ON owner.record_id=q.run_record_id
       WHERE (owner.record_id=? OR owner.parent_run_record_id=?)
         AND q.answered_at IS NOT NULL AND q.delivery_pending_at IS NOT NULL
       ORDER BY q.number`,
    )
    .all(rootId, rootId)
    .map((row) => row.record_id)
  const update = database.query(
    `UPDATE question SET delivery_pending_at=NULL,revision=revision+1
     WHERE record_id=? AND answered_at IS NOT NULL AND delivery_pending_at IS NOT NULL`,
  )
  let retired = 0
  for (const questionId of questionIds) {
    if (update.run(questionId).changes !== 1) continue
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
    enqueueQuestionRecord(database, questionId)
    retired += 1
  }
  return retired
}

export function closeQuestionByOperator(
  questionId: string,
  reasonText: string,
  database: Database = db(),
): void {
  const text = reasonText.trim()
  if (!text) throw new Error('--reason must not be empty')
  const row = database
    .query<
      {
        answered_at: string | null
        closed_at: string | null
        run_record_id: number | null
        workflow_cursor_id: number | null
        cursor_state: string | null
        root_id: string | null
        latest_status: string | null
      },
      [string]
    >(
      `SELECT q.answered_at,q.closed_at,q.run_record_id,q.workflow_cursor_id,c.state cursor_state,
              COALESCE(owner.parent_run_record_id,owner.record_id) root_id,
              (SELECT latest.status FROM run latest
                WHERE latest.record_id=COALESCE(owner.parent_run_record_id,owner.record_id)
                   OR latest.parent_run_record_id=COALESCE(owner.parent_run_record_id,owner.record_id)
                ORDER BY latest.turn DESC,latest.number DESC LIMIT 1) latest_status
         FROM question q
         LEFT JOIN run owner ON owner.record_id=q.run_record_id
         LEFT JOIN workflow_cursor c ON c.id=q.workflow_cursor_id
        WHERE q.record_id=?`,
    )
    .get(questionId)
  if (!row) throw new Error(`no question ${questionId}`)
  if (row.answered_at) throw new Error(`question ${questionId} is already answered`)
  if (row.closed_at) throw new Error(`question ${questionId} is already closed`)
  if (row.workflow_cursor_id !== null && row.cursor_state === 'awaiting-ruling') {
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
  writeTransaction(() => {
    if (closeQuestions(database, [questionId], `${QUESTION_CLOSE_OPERATOR}: ${text}`) !== 1) {
      throw new Error(`question ${questionId} is no longer open`)
    }
  }, database)
}
