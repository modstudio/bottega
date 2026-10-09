// concern: review-record-template
/** Validates and expands a project's argv-only review record command template. */

export const REVIEW_RECORD_PLACEHOLDERS = [
  'tier',
  'reason',
  'agents',
  'findings',
  'branch',
] as const

type ReviewRecordPlaceholder = (typeof REVIEW_RECORD_PLACEHOLDERS)[number]
type ReviewRecordValues = Record<ReviewRecordPlaceholder, string>

const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])

const placeholderPattern = /\{([^{}]+)\}/g

type TokenizerState = {
  tokens: string[]
  token: string
  quote: "'" | '"' | null
  escaped: boolean
  started: boolean
}

function consumeTemplateCharacter(state: TokenizerState, character: string): void {
  if (state.escaped) {
    state.token += character
    state.escaped = false
    state.started = true
  } else if (character === '\\' && state.quote !== "'") {
    state.escaped = true
    state.started = true
  } else if (state.quote) {
    if (character === state.quote) state.quote = null
    else state.token += character
    state.started = true
  } else if (character === "'" || character === '"') {
    state.quote = character
    state.started = true
  } else if (/\s/.test(character)) {
    if (!state.started) return
    state.tokens.push(state.token)
    state.token = ''
    state.started = false
  } else {
    state.token += character
    state.started = true
  }
}

function tokenizeReviewRecordTemplate(template: string): string[] {
  const tokens: string[] = []
  const state: TokenizerState = {
    tokens,
    token: '',
    quote: null,
    escaped: false,
    started: false,
  }
  for (const character of template.trim()) {
    consumeTemplateCharacter(state, character)
  }
  if (state.escaped) throw new Error('review record template ends with an escape')
  if (state.quote) throw new Error(`review record template has an unclosed ${state.quote} quote`)
  if (state.started) tokens.push(state.token)
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
  const command = tokens[0]!.split(/[\\/]/).at(-1)!
  if (SHELL_INTERPRETERS.has(command)) {
    return 'a review record command is run directly with its arguments; a shell interpreter is not allowed'
  }
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
  return tokens.map((token) =>
    token.replace(placeholderPattern, (_match, name: ReviewRecordPlaceholder) => values[name]),
  )
}
