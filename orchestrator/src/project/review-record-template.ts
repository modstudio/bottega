// concern: review-record-template
/** Validates and expands a project's argv-only review record command template. */

export const REVIEW_RECORD_PLACEHOLDERS = [
  'tier',
  'reason',
  'agents',
  'findings',
  'branch',
] as const

export type ReviewRecordPlaceholder = (typeof REVIEW_RECORD_PLACEHOLDERS)[number]
export type ReviewRecordValues = Record<ReviewRecordPlaceholder, string>

const placeholderPattern = /\{([^{}]+)\}/g

export function tokenizeReviewRecordTemplate(template: string): string[] {
  const tokens: string[] = []
  let token = ''
  let quote: "'" | '"' | null = null
  let escaped = false
  let started = false
  for (const character of template.trim()) {
    if (escaped) {
      token += character
      escaped = false
      started = true
      continue
    }
    if (character === '\\' && quote !== "'") {
      escaped = true
      started = true
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      else token += character
      started = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      started = true
      continue
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(token)
        token = ''
        started = false
      }
      continue
    }
    token += character
    started = true
  }
  if (escaped) throw new Error('review record template ends with an escape')
  if (quote) throw new Error(`review record template has an unclosed ${quote} quote`)
  if (started) tokens.push(token)
  if (!tokens.length || !tokens[0]) throw new Error('review record template must name a command')
  return tokens
}

export function reviewRecordTemplateProblem(template: string): string | null {
  let tokens: string[]
  try {
    tokens = tokenizeReviewRecordTemplate(template)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return reviewRecordTokensProblem(tokens)
}

function reviewRecordTokensProblem(tokens: readonly string[]): string | null {
  const placeholders = tokens.flatMap((token) =>
    [...token.matchAll(placeholderPattern)].map((match) => match[1]!),
  )
  const unknown = placeholders.find(
    (placeholder) => !REVIEW_RECORD_PLACEHOLDERS.includes(placeholder as ReviewRecordPlaceholder),
  )
  if (unknown) return `unknown placeholder {${unknown}}`
  if (!placeholders.includes('findings')) return 'template must contain {findings}'
  return null
}

export function reviewRecordArgv(template: string, values: ReviewRecordValues): string[] {
  const tokens = tokenizeReviewRecordTemplate(template)
  const problem = reviewRecordTokensProblem(tokens)
  if (problem) throw new Error(problem)
  return tokens.map((token) =>
    token.replace(placeholderPattern, (_match, name: ReviewRecordPlaceholder) => values[name]),
  )
}
