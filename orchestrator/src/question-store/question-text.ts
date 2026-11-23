// concern: question text
/** Pure validation and wire normalization for text that must reach a handler. */

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

function refusalRemedy(field: string): string {
  if (field !== 'question') return `\`${field}\` must be the ${field} text as a string.`
  return (
    '`question` must be the question text as a string; put kind, options, recommendation and why ' +
    'beside it at the top level of the call, not inside it.'
  )
}

/** Why required text cannot be accepted, or null when it is usable. */
export function questionTextRefusal(value: unknown, field = 'question'): string | null {
  const normalized = requiredTextReachingHandler(value)
  const content = normalized.replace(/\p{Cf}/gu, '').trim()
  let reason: string | null = null
  if (!content) reason = `${field} was empty`
  else if (normalized.startsWith(MALFORMED_REQUIRED_TEXT_PREFIX)) {
    const shape = normalized.slice(MALFORMED_REQUIRED_TEXT_PREFIX.length)
    reason = `${field} was ${shape === 'object' || shape === 'array' ? 'an' : 'a'} ${shape}`
  } else if (content.startsWith('[object ')) reason = `${field} was the text ${content}`
  return reason ? `${reason}. ${refusalRemedy(field)}` : null
}
