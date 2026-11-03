// concern: typed-question-service
/** Asks a declared question and records its success or failure as evidence. */

import { createHash } from 'node:crypto'
import {
  askTypedQuestionClient,
  type TypedQuestionAnswer,
} from '../../../shared/typed-question/client.ts'
import type { TypedQuestion } from '../../../shared/typed-question/registry.ts'
import {
  recordTypedQuestionAnswer,
  type TypedQuestionAnswerRow,
} from './typed-question-answer-store.ts'

type AskTypedQuestionInput = {
  question: TypedQuestion
  subjectKind: string
  subjectRef: string
  state: string | Record<string, unknown>
}

type AskTypedQuestionDependencies = {
  ask: typeof askTypedQuestionClient
  record(row: TypedQuestionAnswerRow): void
}

const serviceDependencies: AskTypedQuestionDependencies = {
  ask: askTypedQuestionClient,
  record: recordTypedQuestionAnswer,
}

export function stateIdentity(state: AskTypedQuestionInput['state']): string {
  const exact = typeof state === 'string' ? state : JSON.stringify(state)
  return createHash('sha256').update(exact).digest('hex')
}

/** Fail open for every client or recording failure; an absent key is not evidence. */
export async function askTypedQuestion(
  input: AskTypedQuestionInput,
  dependencies: AskTypedQuestionDependencies = serviceDependencies,
): Promise<TypedQuestionAnswer | null> {
  try {
    const result = await dependencies.ask(input.question, input.state)
    if (result.kind === 'missing-key') return null
    const common = {
      questionId: input.question.id,
      questionVersion: input.question.version,
      subjectKind: input.subjectKind,
      subjectRef: input.subjectRef,
      stateSha: stateIdentity(input.state),
      latencyMs: result.latencyMs,
    }
    if (result.kind === 'error') {
      dependencies.record({
        ...common,
        answerJson: null,
        model: null,
        inputTokens: null,
        error: result.error,
      })
      return null
    }
    dependencies.record({
      ...common,
      answerJson: JSON.stringify(result.answer),
      model: result.model,
      inputTokens: result.inputTokens,
      error: null,
    })
    return result.answer
  } catch {
    return null
  }
}
