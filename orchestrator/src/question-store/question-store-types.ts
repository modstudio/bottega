// concern: question-store-port-types
/** Declares the question persistence boundary without choosing an adapter. */

import type {
  QuestionIntent,
  QuestionReadInput,
  QuestionWriteBody,
  QuestionWriteResult,
} from '../record/record-question-contract.ts'

export type QuestionReadResult = { items: Record<string, unknown>[] }
export interface QuestionStore {
  write(intent: QuestionIntent, input: QuestionWriteBody): Promise<QuestionWriteResult>
  read(input: QuestionReadInput): Promise<QuestionReadResult>
}

export type QuestionRouteClient = {
  readQuestions?(
    input: QuestionReadInput,
    destination?: { destinationSpaceId?: string },
  ): Promise<QuestionReadResult>
  writeQuestion?(
    intent: QuestionIntent,
    input: QuestionWriteBody,
    destination: { destinationSpaceId: string },
  ): Promise<QuestionWriteResult>
}
