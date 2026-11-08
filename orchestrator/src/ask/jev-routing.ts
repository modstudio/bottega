// concern: worker-question-routing
/** Pure decision for whether Jev advice may become a worker ruling. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
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

export type JevQuestionKind = Exclude<WorkerQuestion['kind'], 'text'>

/** Returns the probability assigned to the selected answer, when it is valid. */
export function pickProbability(
  kind: JevQuestionKind,
  pick: unknown,
  probabilities: unknown,
): number | null {
  if (!probabilities || typeof probabilities !== 'object') return null
  let key: string | null = null
  if (kind === 'yesno') key = typeof pick === 'boolean' ? (pick ? 'yes' : 'no') : null
  else if (kind === 'choice') key = typeof pick === 'string' ? pick : null
  else if (typeof pick === 'number' && Number.isInteger(pick)) key = String(pick)
  if (key === null) return null
  const probability = (probabilities as Record<string, unknown>)[key]
  return typeof probability === 'number' &&
    Number.isFinite(probability) &&
    probability >= 0 &&
    probability <= 1
    ? probability
    : null
}

export function isJevConfidenceThreshold(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

export function invalidJevThresholdRemedy(key: string, raw: string | number): string {
  return `invalid ${key} ${JSON.stringify(raw)}; run ${PLATFORM_SLUG} machine config set ${key} <0-1>`
}

function answerPick(
  question: WorkerQuestion,
  answer: TypedQuestionAnswer,
): string | boolean | number | null {
  if (question.kind === 'yesno' && 'noul' in answer) return answer.noul >= 0.5
  if (question.kind === 'choice' && 'choice' in answer) return answer.choice
  if (question.kind !== 'score' || !('score' in answer)) return null
  return Object.entries(answer.probabilities).reduce(
    (best, [level, probability]) =>
      probability > best.probability ? { level: Number(level), probability } : best,
    { level: 0, probability: -1 },
  ).level
}

export function routeJevAnswer(input: {
  question: WorkerQuestion
  answer: TypedQuestionAnswer | null
  threshold: number
  rulings: 'agent' | 'user'
  autoRule: boolean
  canResume: boolean
  fits: number | null
  orderFlipped: boolean | null
  bothOrdersAnswered: boolean
  fitThreshold: number
}): JevRoutingDecision {
  if (input.question.kind === 'text' || !input.answer)
    return { action: 'escalate', pick: null, probabilities: null, confidence: null }
  const answer = input.answer
  const pick = answerPick(input.question, answer)
  const probabilities =
    'probabilities' in answer ? answer.probabilities : { yes: answer.noul, no: 1 - answer.noul }
  const confidence =
    pick === null ? null : pickProbability(input.question.kind, pick, probabilities)
  if (
    !input.canResume ||
    !input.autoRule ||
    input.rulings !== 'agent' ||
    confidence === null ||
    confidence < input.threshold
  )
    return { action: 'escalate', pick, probabilities, confidence }
  if (
    input.question.kind === 'choice' &&
    (!input.bothOrdersAnswered ||
      input.orderFlipped !== false ||
      input.fits === null ||
      input.fits < input.fitThreshold)
  )
    return { action: 'escalate', pick, probabilities, confidence }
  if (pick !== null) return { action: 'apply', value: pick, pick, probabilities, confidence }
  return { action: 'escalate', pick, probabilities, confidence }
}
