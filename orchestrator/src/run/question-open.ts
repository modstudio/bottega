// concern: question-open
/** Defines the one durable predicate for an open question. */

import type { Database } from 'bun:sqlite'
import { questionsForChain } from '../question-store/question-store-read.ts'
export { questionOpenSql, questionTaskHolderSql } from '../question-store/question-store-sql.ts'

export async function openChainQuestions<T>(
  database: Database,
  runId: string,
  _columns: string,
): Promise<T[]> {
  return (await questionsForChain(database, runId)).filter(
    (row) => row.answered_at === null && row.closed_at === null,
  ) as T[]
}
