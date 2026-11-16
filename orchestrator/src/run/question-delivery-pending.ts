// concern: machine-local pending question delivery
/** Keeps the machine-local pending delivery marker behind one persistence seam. */

import type { Database } from 'bun:sqlite'

export function markQuestionDeliveryPending(
  database: Database,
  questionId: string,
  runId: string | null,
  at: string,
): boolean {
  return (
    database
      .query(`INSERT INTO question_delivery_pending(question_record_id,run_record_id,pending_at)
        VALUES (?,?,?) ON CONFLICT(question_record_id) DO UPDATE SET
        run_record_id=excluded.run_record_id,pending_at=excluded.pending_at`)
      .run(questionId, runId, at).changes === 1
  )
}

export function clearQuestionDeliveryPending(
  database: Database,
  questionIds: readonly string[],
): number {
  if (questionIds.length === 0) return 0
  return database
    .query(
      `DELETE FROM question_delivery_pending
       WHERE question_record_id IN (${questionIds.map(() => '?').join(',')})`,
    )
    .run(...questionIds).changes
}

export function clearQuestionDeliveryPendingForRuns(
  database: Database,
  runIds: readonly string[],
): number {
  if (runIds.length === 0) return 0
  return database
    .query(
      `DELETE FROM question_delivery_pending
       WHERE run_record_id IN (${runIds.map(() => '?').join(',')})`,
    )
    .run(...runIds).changes
}

export function pendingQuestionIds(
  database: Database,
  input: { questionIds?: readonly string[]; runIds?: readonly string[] },
): string[] {
  const clauses: string[] = []
  const values: string[] = []
  if (input.questionIds) {
    if (input.questionIds.length === 0) return []
    clauses.push(`question_record_id IN (${input.questionIds.map(() => '?').join(',')})`)
    values.push(...input.questionIds)
  }
  if (input.runIds) {
    if (input.runIds.length === 0) return []
    clauses.push(`run_record_id IN (${input.runIds.map(() => '?').join(',')})`)
    values.push(...input.runIds)
  }
  return database
    .query<{ question_record_id: string }, string[]>(
      `SELECT question_record_id FROM question_delivery_pending${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY pending_at,question_record_id`,
    )
    .all(...values)
    .map(({ question_record_id }) => question_record_id)
}
