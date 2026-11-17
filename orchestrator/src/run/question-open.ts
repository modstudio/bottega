// concern: question-open
/** Owns chain membership plus the one durable predicate for a chain's open questions. */

import type { Database } from 'bun:sqlite'
import { runChainIds } from './run-chain.ts'
export async function questionsForRunChain(
  database: Database,
  runId: string,
): Promise<Record<string, unknown>[]> {
  const { questionsForRuns } = await import('../question-store/question-store-read.ts')
  return questionsForRuns(database, runChainIds(database, runId))
}

export async function questionsForRunChains(
  database: Database,
  rootIds: readonly string[],
): Promise<Map<string, Record<string, unknown>[]>> {
  const { questionsForRuns } = await import('../question-store/question-store-read.ts')
  const chains = new Map(rootIds.map((rootId) => [rootId, runChainIds(database, rootId)]))
  const questions = await questionsForRuns(database, [...new Set([...chains.values()].flat())])
  const byRun = Map.groupBy(questions, (question) => String(question.run_record_id))
  return new Map(
    [...chains].map(([rootId, runIds]) => [
      rootId,
      runIds.flatMap((runId) => byRun.get(runId) ?? []),
    ]),
  )
}

export async function openChainQuestions<T>(database: Database, runId: string): Promise<T[]> {
  // Keep the degraded `collect` command's startup graph thin while still crossing
  // the question port when the asking-state branch is actually evaluated.
  return (await questionsForRunChain(database, runId)).filter(
    (row) => row.answered_at === null && row.closed_at === null,
  ) as T[]
}
