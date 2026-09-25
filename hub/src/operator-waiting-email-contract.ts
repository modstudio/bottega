// concern: operator-waiting-email-contract
/** Wire contract shared by the local client and hosted operator-waiting email endpoint. */

import { z } from 'zod'

const OPERATOR_EMAIL_MAX_TEXT = 4_000
const OPERATOR_EMAIL_MAX_FIELD = 500
const OPERATOR_EMAIL_MAX_LINK = 2_000
const OPERATOR_EMAIL_MAX_OPTIONS = 20

const field = z.string().min(1).max(OPERATOR_EMAIL_MAX_FIELD)
const nullableField = z.string().max(OPERATOR_EMAIL_MAX_FIELD).nullable()

export const operatorWaitingEmailRequestSchema = z
  .object({
    kind: z.enum(['question', 'workflow']),
    item_id: z.number().int().positive(),
    episode: field,
    project: field,
    task_key: nullableField,
    question: z.string().min(1).max(OPERATOR_EMAIL_MAX_TEXT),
    options: z.array(field).max(OPERATOR_EMAIL_MAX_OPTIONS),
    recommendation: nullableField,
    why: z.string().max(OPERATOR_EMAIL_MAX_TEXT).nullable(),
    waiting_since: z.iso.datetime().max(OPERATOR_EMAIL_MAX_FIELD),
    link: z.url().max(OPERATOR_EMAIL_MAX_LINK),
    answer_command: field,
  })
  .strict()

export const operatorWaitingEmailResponseSchema = z
  .object({
    id: z.string(),
    status: z.enum(['intent', 'sent', 'failed', 'abandoned']),
    reason: z.string().nullable(),
  })
  .strict()

export type OperatorWaitingEmailInput = z.infer<typeof operatorWaitingEmailRequestSchema>
export type OperatorWaitingEmailResult = z.infer<typeof operatorWaitingEmailResponseSchema>
