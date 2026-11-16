// concern: question-open
/** Defines the one durable predicate for an open question. */

import type { Database } from 'bun:sqlite'
export async function openChainQuestions<T>(
  database: Database,
  runId: string,
  _columns: string,
): Promise<T[]> {
  // Keep the degraded `collect` command's startup graph thin while still crossing
  // the question port when the asking-state branch is actually evaluated.
  const { questionsForChain } = await import('../question-store/question-store-read.ts')
  return (await questionsForChain(database, runId)).filter(
    (row) => row.answered_at === null && row.closed_at === null,
  ) as T[]
}
