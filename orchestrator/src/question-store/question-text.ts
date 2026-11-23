// concern: question text
/** Pure validation and wire normalization for text that must reach a handler. */

import { z } from 'zod'

export const MALFORMED_REQUIRED_TEXT_PREFIX = '__bottega_malformed_required_text__:'

function valueShape(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  return typeof value
}

export function requiredTextReachingHandler(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return `${MALFORMED_REQUIRED_TEXT_PREFIX}${valueShape(value)}`
}

export const requiredHandlerText = z.preprocess(requiredTextReachingHandler, z.string())

function refusalRemedy(field: string): string {
  if (field === 'text') return '`text` must be the note as a single-line string.'
  if (field === 'body') return '`body` must be the message as a string.'
  return '`question` must be the question text as a string; put kind, options, recommendation and why beside it at the top level of the call, not inside it.'
}

export type RequiredTextRefusal = { kind: 'empty' | 'malformed'; message: string }

/** Why required text cannot be accepted, or null when it is usable. */
export function questionTextRefusal(
  value: unknown,
  field = 'question',
): RequiredTextRefusal | null {
  const normalized = requiredTextReachingHandler(value)
  const content = normalized.replace(/\p{Cf}/gu, '').trim()
  let reason: string | null = null
  let kind: RequiredTextRefusal['kind'] = 'malformed'
  if (!content) {
    kind = 'empty'
    reason = `${field} was empty`
  } else if (normalized.startsWith(MALFORMED_REQUIRED_TEXT_PREFIX)) {
    const shape = normalized.slice(MALFORMED_REQUIRED_TEXT_PREFIX.length)
    reason = `${field} was ${shape === 'object' || shape === 'array' ? 'an' : 'a'} ${shape}`
  } else if (/^\[object [A-Za-z]+\]$/.test(content)) reason = `${field} was the text ${content}`
  return reason ? { kind, message: `${reason}. ${refusalRemedy(field)}` } : null
}

export const requiredQuestionText = requiredHandlerText.superRefine((value, context) => {
  const refusal = questionTextRefusal(value)
  if (refusal) context.addIssue({ code: 'custom', message: refusal.message })
})
