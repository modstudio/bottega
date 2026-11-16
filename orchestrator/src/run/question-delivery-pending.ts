// concern: machine-local pending question delivery
/** Keeps the machine-local pending delivery marker behind one persistence seam. */

import type { Database } from 'bun:sqlite'

export function markQuestionDeliveryPending(
  database: Database,
  questionId: string,
  at: string,
): boolean {
  return (
    database
      .query('UPDATE question SET delivery_pending_at=? WHERE record_id=?')
      .run(at, questionId).changes === 1
  )
}

export function clearQuestionDeliveryPending(
  database: Database,
  questionIds: readonly string[],
): number {
  if (questionIds.length === 0) return 0
  return database
    .query(
      `UPDATE question SET delivery_pending_at=NULL
       WHERE delivery_pending_at IS NOT NULL AND record_id IN (${questionIds.map(() => '?').join(',')})`,
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
      `UPDATE question SET delivery_pending_at=NULL
       WHERE delivery_pending_at IS NOT NULL AND run_record_id IN (${runIds.map(() => '?').join(',')})`,
    )
    .run(...runIds).changes
}

export function pendingQuestionIds(
  database: Database,
  input: { questionIds?: readonly string[]; runIds?: readonly string[] },
): string[] {
  const clauses = ['delivery_pending_at IS NOT NULL']
  const values: string[] = []
  if (input.questionIds) {
    if (input.questionIds.length === 0) return []
    clauses.push(`record_id IN (${input.questionIds.map(() => '?').join(',')})`)
    values.push(...input.questionIds)
  }
  if (input.runIds) {
    if (input.runIds.length === 0) return []
    clauses.push(`run_record_id IN (${input.runIds.map(() => '?').join(',')})`)
    values.push(...input.runIds)
  }
  return database
    .query<{ record_id: string }, string[]>(
      `SELECT record_id FROM question WHERE ${clauses.join(' AND ')} ORDER BY number`,
    )
    .all(...values)
    .map(({ record_id }) => record_id)
}
