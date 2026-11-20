// concern: record-api-client-question
/** Calls the hosted question routes and validates write results. */

import type { RecordRequestDestination, RecordWriteDestination } from './record-api-client-paths.ts'
import { RecordApiRequestError } from './record-api-client-response.ts'
import type { RecordIdentity } from './record-auth.ts'
import {
  RUN_QUESTION_OWNER_NOT_LIVE_CODE,
  RunQuestionOwnerNotLiveError,
} from '../question-store/run-question-write-guard.ts'
import {
  type QuestionImportBody,
  type QuestionLiveIntent,
  type QuestionReadInput,
  type QuestionWriteBody,
  type QuestionWriteResult,
  questionWriteResultSchema,
} from './record-question-contract.ts'

type Request = <T>(
  path: string,
  init?: RequestInit & { schema?: (body: unknown) => T; destinationSpaceId?: string },
) => Promise<T>

export type RecordQuestionClient = {
  whoami?(): Promise<RecordIdentity>
  readQuestions?(
    input: QuestionReadInput,
    destination?: RecordRequestDestination,
  ): Promise<{
    items: Record<string, unknown>[]
    cursor?: string
    more?: boolean
    reset?: boolean
  }>
  writeQuestion?(
    intent: QuestionLiveIntent,
    input: QuestionWriteBody,
    destination: RecordWriteDestination,
  ): Promise<QuestionWriteResult>
  importQuestion?(
    input: QuestionImportBody,
    destination: RecordWriteDestination,
  ): Promise<QuestionWriteResult>
}

export function requireQuestionWriteClient(
  client: RecordQuestionClient,
): RecordQuestionClient & { writeQuestion: NonNullable<RecordQuestionClient['writeQuestion']> } {
  if (!client.writeQuestion)
    throw new Error('record API predates direct question writes; release hosted-api, then retry')
  return client as RecordQuestionClient & {
    writeQuestion: NonNullable<RecordQuestionClient['writeQuestion']>
  }
}

async function writeQuestion(
  request: Request,
  intent: QuestionLiveIntent,
  input: QuestionWriteBody,
  destination: RecordWriteDestination,
): Promise<QuestionWriteResult> {
  try {
    return await request(`/v1/questions/${intent}`, {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
      schema: (body) => questionWriteResultSchema.parse(body),
    })
  } catch (error) {
    if (
      error instanceof RecordApiRequestError &&
      error.status === 409 &&
      error.code === RUN_QUESTION_OWNER_NOT_LIVE_CODE &&
      input.question.runId
    )
      throw new RunQuestionOwnerNotLiveError(input.question.runId)
    throw error
  }
}

export const recordQuestionClient = (request: Request): RecordQuestionClient => {
  const routes = {
    readQuestions: (input: QuestionReadInput, destination?: RecordRequestDestination) => {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(input))
        if (value !== undefined) query.set(key, String(value))
      return request(`/v1/questions?${query}`, {
        ...destination,
        schema: (body) =>
          body as {
            items: Record<string, unknown>[]
            cursor?: string
            more?: boolean
            reset?: boolean
          },
      })
    },
    writeQuestion: (intent, input, destination) =>
      writeQuestion(request, intent, input, destination),
    importQuestion: (input: QuestionImportBody, destination: RecordWriteDestination) =>
      request('/v1/questions/import', {
        method: 'POST',
        body: JSON.stringify(input),
        ...destination,
        schema: (body) => questionWriteResultSchema.parse(body),
      }),
  }
  return routes
}
