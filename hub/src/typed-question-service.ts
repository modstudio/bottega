// concern: typed-question-service
/** Asks and records hub-owned typed questions without exposing failures to callers. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../shared/record-id.ts'
import {
  askTypedQuestionClient,
  type TypedQuestionAnswer,
} from '../../shared/typed-question/client.ts'
import type { TypedQuestion } from '../../shared/typed-question/registry.ts'
import { typedQuestionStateIdentity } from '../../shared/typed-question/state-identity.ts'
import { db, nowIso, writeTransaction } from './db.ts'

export type HubTypedQuestionInput = {
  question: TypedQuestion
  subjectKind: string
  subjectRef: string
  state: string | Record<string, unknown>
}

type Dependencies = {
  ask: typeof askTypedQuestionClient
  database(): Database
  record(database: Database, values: readonly (string | number | null)[]): void
}

const dependencies: Dependencies = {
  ask: askTypedQuestionClient,
  database: db,
  record: (_database, values) => {
    writeTransaction((database) => {
      database
        .query(
          `INSERT INTO typed_question_answer
           (record_id,question_id,question_version,subject_kind,subject_ref,state_sha,state_json,
            answer_json,model,input_tokens,latency_ms,error,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(...values)
    })
  },
}

function priorAnswer(input: HubTypedQuestionInput, database: Database): TypedQuestionAnswer | null {
  const row = database
    .query<{ answer_json: string }, [string, number, string, string]>(
      `SELECT answer_json FROM typed_question_answer
       WHERE question_id=? AND question_version=? AND subject_ref=? AND state_sha=?
         AND answer_json IS NOT NULL AND error IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(
      input.question.id,
      input.question.version,
      input.subjectRef,
      typedQuestionStateIdentity(input.state),
    )
  if (!row) return null
  try {
    return JSON.parse(row.answer_json) as TypedQuestionAnswer
  } catch {
    return null
  }
}

/** Reuse exact evidence, otherwise fail open for every client or recording failure. */
export async function askHubTypedQuestion(
  input: HubTypedQuestionInput,
  deps: Dependencies = dependencies,
): Promise<TypedQuestionAnswer | null> {
  try {
    const database = deps.database()
    const prior = priorAnswer(input, database)
    if (prior) return prior
    const result = await deps.ask(input.question, input.state)
    if (result.kind === 'missing-key') return null
    const common = [
      newRecordId(),
      input.question.id,
      input.question.version,
      input.subjectKind,
      input.subjectRef,
      typedQuestionStateIdentity(input.state),
      JSON.stringify(input.state),
    ]
    if (result.kind === 'error') {
      deps.record(database, [...common, null, null, null, result.latencyMs, result.error, nowIso()])
      return null
    }
    deps.record(database, [
      ...common,
      JSON.stringify(result.answer),
      result.model,
      result.inputTokens,
      result.latencyMs,
      null,
      nowIso(),
    ])
    return result.answer
  } catch {
    return null
  }
}
