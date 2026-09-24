// concern: question-vocabulary
/** Knows question provenance and delivery vocabularies, but no database state or adapters. */

const ASKED_VIA = ['live', 'reply'] as const
const ANSWERER_KINDS = ['agent', 'operator', 'eval'] as const
const ANSWER_CHANNELS = ['cli', 'mcp', 'ui'] as const
const QUESTION_DELIVERY_MODES = ['live', 'resume', 'retry', 'record-only'] as const
const QUESTION_DELIVERY_OUTCOMES = ['delivered', 'failed'] as const

export type AskedVia = (typeof ASKED_VIA)[number]
export type AnswererKind = (typeof ANSWERER_KINDS)[number]
export type AnswerChannel = (typeof ANSWER_CHANNELS)[number]
export type QuestionDeliveryMode = (typeof QUESTION_DELIVERY_MODES)[number]
export type QuestionDeliveryOutcome = (typeof QUESTION_DELIVERY_OUTCOMES)[number]

export const ASKED_VIA_LIVE = 'live' satisfies AskedVia
export const ASKED_VIA_REPLY = 'reply' satisfies AskedVia
export const ANSWERER_KIND_AGENT = 'agent' satisfies AnswererKind
const ANSWERER_KIND_OPERATOR = 'operator' satisfies AnswererKind
export const ANSWERER_KIND_EVAL = 'eval' satisfies AnswererKind
export const ANSWER_CHANNEL_CLI = 'cli' satisfies AnswerChannel
export const QUESTION_DELIVERY_MODE_LIVE = 'live' satisfies QuestionDeliveryMode
export const QUESTION_DELIVERY_MODE_RESUME = 'resume' satisfies QuestionDeliveryMode
export const QUESTION_DELIVERY_MODE_RETRY = 'retry' satisfies QuestionDeliveryMode
export const QUESTION_DELIVERY_MODE_RECORD_ONLY = 'record-only' satisfies QuestionDeliveryMode
export const QUESTION_DELIVERY_OUTCOME_DELIVERED = 'delivered' satisfies QuestionDeliveryOutcome
export const QUESTION_DELIVERY_OUTCOME_FAILED = 'failed' satisfies QuestionDeliveryOutcome

export function answererKindFromAnsweredBy(answeredBy: string | null): AnswererKind | null {
  if (answeredBy === null) return null
  if (answeredBy.startsWith('operator via ')) return ANSWERER_KIND_OPERATOR
  if (answeredBy === 'canon-eval') return ANSWERER_KIND_EVAL
  return ANSWERER_KIND_AGENT
}
