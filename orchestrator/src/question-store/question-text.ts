// concern: question text
/** Pure validation and wire normalization for text that must reach a handler. */

import { z } from 'zod'
import { questionTextRefusal, requiredTextReachingHandler } from './question-text-refusal.ts'

export const requiredHandlerText = z.preprocess(requiredTextReachingHandler, z.string())

export const requiredQuestionText = requiredHandlerText.superRefine((value, context) => {
  const refusal = questionTextRefusal(value)
  if (refusal) context.addIssue({ code: 'custom', message: refusal.message })
})
