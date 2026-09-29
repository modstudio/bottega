export const ASKED_VIA_VALUES = ['live', 'reply', 'workflow'] as const
export const ANSWERER_KIND_VALUES = ['agent', 'operator', 'eval'] as const
export const ANSWER_CHANNEL_VALUES = ['cli', 'mcp', 'ui'] as const
export const QUESTION_DELIVERY_MODE_VALUES = ['live', 'resume', 'retry', 'record-only'] as const
export const QUESTION_DELIVERY_OUTCOME_VALUES = ['delivered', 'failed', 'retired'] as const

export type AskedVia = (typeof ASKED_VIA_VALUES)[number]
export type AnswererKind = (typeof ANSWERER_KIND_VALUES)[number]
export type AnswerChannel = (typeof ANSWER_CHANNEL_VALUES)[number]
export type QuestionDeliveryMode = (typeof QUESTION_DELIVERY_MODE_VALUES)[number]
export type QuestionDeliveryOutcome = (typeof QUESTION_DELIVERY_OUTCOME_VALUES)[number]

export const ASKED_VIA_LIVE = 'live' satisfies AskedVia
export const ASKED_VIA_REPLY = 'reply' satisfies AskedVia
export const ANSWERER_KIND_AGENT = 'agent' satisfies AnswererKind
export const ANSWERER_KIND_OPERATOR = 'operator' satisfies AnswererKind
export const ANSWERER_KIND_EVAL = 'eval' satisfies AnswererKind
export const ANSWER_CHANNEL_CLI = 'cli' satisfies AnswerChannel
export const QUESTION_DELIVERY_MODE_LIVE = 'live' satisfies QuestionDeliveryMode
export const QUESTION_DELIVERY_MODE_RESUME = 'resume' satisfies QuestionDeliveryMode
export const QUESTION_DELIVERY_MODE_RETRY = 'retry' satisfies QuestionDeliveryMode
export const QUESTION_DELIVERY_MODE_RECORD_ONLY = 'record-only' satisfies QuestionDeliveryMode
export const QUESTION_DELIVERY_OUTCOME_DELIVERED = 'delivered' satisfies QuestionDeliveryOutcome
export const QUESTION_DELIVERY_OUTCOME_FAILED = 'failed' satisfies QuestionDeliveryOutcome
export const QUESTION_DELIVERY_OUTCOME_RETIRED = 'retired' satisfies QuestionDeliveryOutcome
