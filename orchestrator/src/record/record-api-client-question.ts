// concern: record-api-client-question
/** Calls the hosted question routes and validates write results. */

import type { RecordRequestDestination, RecordWriteDestination } from './record-api-client-paths.ts'
import {
  type QuestionIntent,
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
  readQuestions?(
    input: QuestionReadInput,
    destination?: RecordRequestDestination,
  ): Promise<{ items: Record<string, unknown>[] }>
  writeQuestion?(
    intent: QuestionIntent,
    input: QuestionWriteBody,
    destination: RecordWriteDestination,
  ): Promise<QuestionWriteResult>
}

export const recordQuestionClient = (request: Request): RecordQuestionClient => ({
  readQuestions: (input, destination) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(input))
      if (value !== undefined) query.set(key, String(value))
    return request(`/v1/questions?${query}`, {
      ...destination,
      schema: (body) => body as { items: Record<string, unknown>[] },
    })
  },
  writeQuestion: (intent, input, destination) =>
    request(`/v1/questions/${intent}`, {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
      schema: (body) => questionWriteResultSchema.parse(body),
    }),
})
