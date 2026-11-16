// concern: question-open
/** Defines the one durable predicate for an open question. */

import type { Database } from 'bun:sqlite'
import { questionsForChain } from '../question-store/question-store-read.ts'

export function questionOpenSql(alias: string): string {
  return `${alias}.answered_at IS NULL AND ${alias}.closed_at IS NULL`
}

/** Resolves a question's task holder without changing the established run/workflow precedence. */
export function questionTaskHolderSql(questionAlias: string, runAlias: string): string {
  return (
    `COALESCE(${runAlias}.launch_key,${questionAlias}.workflow_key,` +
    `(SELECT root.launch_key FROM run root WHERE root.record_id=${runAlias}.parent_run_record_id))`
  )
}

export async function openChainQuestions<T>(
  database: Database,
  runId: string,
  _columns: string,
): Promise<T[]> {
  return (await questionsForChain(database, runId)).filter(
    (row) => row.answered_at === null && row.closed_at === null,
  ) as T[]
}
