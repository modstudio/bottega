// concern: worker-question-routing
/** Pure decision for whether Jev advice may become a worker ruling. */

import type { TypedQuestionAnswer } from '../../../shared/typed-question/client.ts'
import type { WorkerQuestion } from './worker-question.ts'

export type JevRoutingDecision =
  | {
      action: 'apply'
      value: string | boolean | number
      pick: string | boolean | number
      probabilities: Record<string, number>
      confidence: number
    }
  | {
      action: 'escalate'
      pick: string | boolean | number | null
      probabilities: Record<string, number> | null
      confidence: number | null
    }

export function routeJevAnswer(input: {
  question: WorkerQuestion
  answer: TypedQuestionAnswer | null
  threshold: number
  rulings: 'agent' | 'user'
  autoRule: boolean
  canResume: boolean
}): JevRoutingDecision {
  if (input.question.kind === 'text' || !input.answer)
    return { action: 'escalate', pick: null, probabilities: null, confidence: null }
  const answer = input.answer
  const pick =
    input.question.kind === 'yesno' && 'noul' in answer
      ? answer.noul >= 0.5
      : input.question.kind === 'choice' && 'choice' in answer
        ? answer.choice
        : input.question.kind === 'score' && 'score' in answer
          ? Object.entries(answer.probabilities).reduce(
              (best, [level, probability]) =>
                probability > best.probability ? { level: Number(level), probability } : best,
              { level: 0, probability: -1 },
            ).level
          : null
  const probabilities =
    'probabilities' in answer ? answer.probabilities : { yes: answer.noul, no: 1 - answer.noul }
  const confidence =
    'noul' in answer
      ? Math.max(answer.noul, 1 - answer.noul)
      : pick === null
        ? null
        : (answer.probabilities[String(pick)] ?? null)
  if (
    !input.canResume ||
    !input.autoRule ||
    input.rulings !== 'agent' ||
    confidence === null ||
    confidence < input.threshold
  )
    return { action: 'escalate', pick, probabilities, confidence }
  if (pick !== null) return { action: 'apply', value: pick, pick, probabilities, confidence }
  return { action: 'escalate', pick, probabilities, confidence }
}
