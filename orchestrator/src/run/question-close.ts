// concern: question-close
/** Knows when and how an unanswered question is closed. Must not know CLI grammar. */

import type { Database } from 'bun:sqlite'
import { db, nowIso, sessionId, writeTransaction } from '../database/db.ts'
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

function questionIdsForRunChain(database: Database, rootId: number): number[] {
  return database
    .query<{ id: number }, [number, number]>(
      `SELECT q.id FROM question q JOIN run owner ON owner.id=q.run_id
       WHERE (owner.id=? OR owner.parent_run_id=?) AND ${questionOpenSql('q')}
       ORDER BY q.id`,
    )
    .all(rootId, rootId)
    .map((row) => row.id)
}

export function closeQuestions(
  database: Database,
  questionIds: readonly number[],
  reason: QuestionCloseReason,
  actor: string | null = sessionId(),
  at: string = nowIso(),
): number {
  const update = database.query(
    `UPDATE question SET closed_at=?,close_reason=?,revision=revision+1
     WHERE id=? AND ${questionOpenSql('question')}`,
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
  rootId: number,
  reason: QuestionCloseReason,
): number {
  const closed = closeQuestions(database, questionIdsForRunChain(database, rootId), reason)
  retireRunChainQuestionDeliveries(database, rootId, reason)
  return closed
}

/** Retires rulings that can no longer be delivered because their chain has ended. */
export function retireRunChainQuestionDeliveries(
  database: Database,
  rootId: number,
  reason: QuestionCloseReason,
  at: string = nowIso(),
): number {
  const live = database
    .query(
      `SELECT 1 FROM run
       WHERE (id=? OR parent_run_id=?) AND status IN ('running','asking')
       LIMIT 1`,
    )
    .get(rootId, rootId)
  if (live) return 0
  const questionIds = database
    .query<{ id: number }, [number, number]>(
      `SELECT q.id FROM question q JOIN run owner ON owner.id=q.run_id
       WHERE (owner.id=? OR owner.parent_run_id=?)
         AND q.answered_at IS NOT NULL AND q.delivery_pending_at IS NOT NULL
       ORDER BY q.id`,
    )
    .all(rootId, rootId)
    .map((row) => row.id)
  const update = database.query(
    `UPDATE question SET delivery_pending_at=NULL,revision=revision+1
     WHERE id=? AND answered_at IS NOT NULL AND delivery_pending_at IS NOT NULL`,
  )
  let retired = 0
  for (const questionId of questionIds) {
    if (update.run(questionId).changes !== 1) continue
    database
      .query(
        `INSERT INTO question_delivery (question_id,run_id,mode,outcome,at,error)
         VALUES (?,NULL,'record-only','retired',?,?)`,
      )
      .run(questionId, at, reason)
    enqueueQuestionRecord(database, questionId)
    retired += 1
  }
  return retired
}

export function closeQuestionByOperator(
  questionId: number,
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
        run_id: number | null
        workflow_cursor_id: number | null
        cursor_state: string | null
        root_id: number | null
        latest_status: string | null
      },
      [number]
    >(
      `SELECT q.answered_at,q.closed_at,q.run_id,q.workflow_cursor_id,c.state cursor_state,
              COALESCE(owner.parent_run_id,owner.id) root_id,
              (SELECT latest.status FROM run latest
                WHERE latest.id=COALESCE(owner.parent_run_id,owner.id)
                   OR latest.parent_run_id=COALESCE(owner.parent_run_id,owner.id)
                ORDER BY latest.turn DESC,latest.id DESC LIMIT 1) latest_status
         FROM question q
         LEFT JOIN run owner ON owner.id=q.run_id
         LEFT JOIN workflow_cursor c ON c.id=q.workflow_cursor_id
        WHERE q.id=?`,
    )
    .get(questionId)
  if (!row) throw new Error(`no question ${questionId}`)
  if (row.answered_at) throw new Error(`question ${questionId} is already answered`)
  if (row.closed_at) throw new Error(`question ${questionId} is already closed`)
  if (row.workflow_cursor_id !== null && row.cursor_state === 'awaiting-ruling') {
    throw new Error(
      `question ${questionId} belongs to a workflow awaiting a ruling; use orch workflow rule or orch workflow abandon`,
    )
  }
  if (row.run_id !== null && (row.latest_status === 'running' || row.latest_status === 'asking')) {
    throw new Error(`question ${questionId}'s chain is live; use orch answer ${row.root_id}`)
  }
  writeTransaction(() => {
    if (closeQuestions(database, [questionId], `${QUESTION_CLOSE_OPERATOR}: ${text}`) !== 1) {
      throw new Error(`question ${questionId} is no longer open`)
    }
  }, database)
}
