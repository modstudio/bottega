// concern: question-open
/** Defines the one durable predicate for an open question. */

import type { Database } from 'bun:sqlite'

export const questionOpenSql = (alias: string): string =>
  `${alias}.answered_at IS NULL AND ${alias}.closed_at IS NULL`

export function openChainQuestions<T>(
  database: Database,
  runId: string,
  columns: string,
): T[] {
  return database
    .query(
      `SELECT ${columns} FROM question q JOIN run r ON r.record_id=q.run_record_id
       WHERE (r.record_id=? OR r.parent_run_record_id=?) AND ${questionOpenSql('q')}
       ORDER BY q.number`,
    )
    .all(runId, runId) as T[]
}
