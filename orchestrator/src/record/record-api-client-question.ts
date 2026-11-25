// concern: record-api-client-question
/** Calls the hosted question routes and validates write results. */

import {
  RUN_QUESTION_OWNER_NOT_LIVE_CODE,
  RunQuestionOwnerNotLiveError,
} from '../question-store/run-question-write-guard.ts'
import { HOSTED_API_RELEASE_COMMAND } from './outbox-held-contract.ts'
import type { RecordRequestDestination, RecordWriteDestination } from './record-api-client-paths.ts'
import type { RecordIdentity } from './record-auth.ts'
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

type QuestionReadResponse = {
  items: Record<string, unknown>[]
  cursor?: string
  more?: boolean
  reset?: boolean
}

function questionReadResponseSchema(input: QuestionReadInput, body: unknown): QuestionReadResponse {
  const response = body as QuestionReadResponse
  if (input.read !== 'open-for-session') return response
  const valid =
    Array.isArray(response?.items) &&
    response.items.every(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        Array.isArray(row.step_actions) &&
        row.step_actions.every((action) => typeof action === 'string'),
    )
  if (!valid) {
    throw new Error(
      `the hosted API predates this client: open-for-session rows require step_actions as a string array; run ${HOSTED_API_RELEASE_COMMAND}`,
    )
  }
  return response
}

function isOwnerNotLiveResponse(error: unknown): error is { status: 409; code: string } {
  return (
    error !== null &&
    typeof error === 'object' &&
    'status' in error &&
    error.status === 409 &&
    'code' in error &&
    error.code === RUN_QUESTION_OWNER_NOT_LIVE_CODE
  )
}

export type RecordQuestionClient = {
  whoami?(): Promise<RecordIdentity>
  readQuestions?(
    input: QuestionReadInput,
    destination?: RecordRequestDestination,
  ): Promise<QuestionReadResponse>
  readMembershipQuestions?(input: QuestionReadInput): Promise<QuestionReadResponse>
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
    if (isOwnerNotLiveResponse(error) && input.question.runId)
      throw new RunQuestionOwnerNotLiveError(input.question.runId)
    throw error
  }
}

export const recordQuestionClient = (request: Request): RecordQuestionClient => {
  const readResponse = (body: unknown) =>
    body as {
      items: Record<string, unknown>[]
      cursor?: string
      more?: boolean
      reset?: boolean
    }
  const searchParams = (input: QuestionReadInput) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(input))
      if (value !== undefined) query.set(key, String(value))
    return query
  }
  const routes = {
    readQuestions: (input: QuestionReadInput, destination?: RecordRequestDestination) => {
      const query = searchParams(input)
      return request(`/v1/questions?${query}`, {
        ...destination,
        schema: (body) => questionReadResponseSchema(input, body),
      })
    },
    readMembershipQuestions: async (input: QuestionReadInput) => {
      try {
        return await request(`/v1/questions/memberships?${searchParams(input)}`, {
          schema: readResponse,
        })
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'status' in error &&
          (error.status === 404 || error.status === 405)
        ) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(
            `${detail}; deploy the hosted API with \`scripts/deploy/hosted api\`, then retry`,
            { cause: error },
          )
        }
        throw error
      }
    },
    writeQuestion: (
      intent: QuestionLiveIntent,
      input: QuestionWriteBody,
      destination: RecordWriteDestination,
    ) => writeQuestion(request, intent, input, destination),
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
