// concern: worker-question-routing
/** Pure decision for whether Jev advice may become a worker ruling. */

import type { TypedQuestionAnswer } from '../../../shared/typed-question/client.ts'
import type { WorkerQuestion } from '../../../shared/worker-question.ts'

export type JevRoutingDecision =
  | { action: 'apply'; value: string | boolean | number; confidence: number }
  | { action: 'escalate'; confidence: number | null }

export function routeJevAnswer(input: {
  question: WorkerQuestion
  answer: TypedQuestionAnswer | null
  threshold: number
  rulings: 'agent' | 'user'
  autoRule: boolean
  canResume: boolean
}): JevRoutingDecision {
  if (input.question.kind === 'text' || !input.answer)
    return { action: 'escalate', confidence: null }
  const answer = input.answer
  const confidence = 'noul' in answer ? Math.max(answer.noul, 1 - answer.noul) : answer.confidence
  if (
    !input.canResume ||
    !input.autoRule ||
    input.rulings !== 'agent' ||
    confidence < input.threshold
  )
    return { action: 'escalate', confidence }
  if (input.question.kind === 'yesno' && 'noul' in answer)
    return { action: 'apply', value: answer.noul >= 0.5, confidence }
  if (input.question.kind === 'choice' && 'choice' in answer)
    return { action: 'apply', value: answer.choice, confidence }
  if (input.question.kind === 'score' && 'score' in answer) {
    const value = Object.entries(answer.probabilities).reduce(
      (best, [level, probability]) =>
        probability > best.probability ? { level: Number(level), probability } : best,
      { level: 0, probability: -1 },
    ).level
    return { action: 'apply', value, confidence }
  }
  return { action: 'escalate', confidence }
}
