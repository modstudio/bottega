// concern: secret-shaped
/** Detection and redaction of text that resembles credentials. */
import table from './secret-shaped-rules.json' with { type: 'json' }

type RuleKind = 'span' | 'pem' | 'jwt' | 'base64'
type RuleDefinition = { name: string; kind: RuleKind; pattern: string; ignoreCase: boolean }

const definitions = table.rules as RuleDefinition[]
const EXEMPT_EVIDENCE_TOKEN = new RegExp(
  table.exemptEvidenceToken.pattern,
  `g${table.exemptEvidenceToken.ignoreCase ? 'i' : ''}`,
)

function withheldMarker(rule: string): string {
  return `[withheld: ${rule}]`
}

export const WITHHELD_SECRET_SHAPED = withheldMarker('secret-shaped content')

type SecretSpan = { start: number; end: number }
type SecretRule = { name: string; spans: (text: string) => SecretSpan[] }

const regexSpans = (pattern: RegExp, text: string): SecretSpan[] =>
  [...text.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))

const filteredSpans = (
  pattern: RegExp,
  text: string,
  accepts: (candidate: string) => boolean,
): SecretSpan[] =>
  [...text.matchAll(pattern)]
    .filter((match) => accepts(match[0]))
    .map((match) => ({ start: match.index, end: match.index + match[0].length }))

const pemSpans = (pattern: RegExp, text: string): SecretSpan[] =>
  [...text.matchAll(pattern)].map((match) => {
    const endMarker = `-----END ${match[1]}-----`
    const endStart = text.indexOf(endMarker, match.index + match[0].length)
    return {
      start: match.index,
      end: endStart < 0 ? text.length : endStart + endMarker.length,
    }
  })

const RULES: readonly SecretRule[] = definitions.map((definition) => {
  const pattern = new RegExp(definition.pattern, `g${definition.ignoreCase ? 'i' : ''}`)
  if (definition.kind === 'pem')
    return { name: definition.name, spans: (text) => pemSpans(pattern, text) }
  if (definition.kind === 'jwt')
    return {
      name: definition.name,
      spans: (text) => filteredSpans(pattern, text, jwtHeaderIsObject),
    }
  if (definition.kind === 'base64')
    return {
      name: definition.name,
      spans: (text) => filteredSpans(pattern, text, base64RunIsSecret),
    }
  return { name: definition.name, spans: (text) => regexSpans(pattern, text) }
})

export function secretShapedRule(text: string): string | null {
  return secretShapedRules(text)[0] ?? null
}

function secretShapedRules(text: string): string[] {
  return RULES.filter((rule) => rule.spans(text).length > 0).map((rule) => rule.name)
}

export function containsSecretShaped(text: string): boolean {
  return secretShapedRule(text) !== null
}

function abbreviateKnownCommits(text: string, knownCommits: readonly string[]): string {
  return knownCommits.reduce(
    (current, commit) =>
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)
        ? current.replaceAll(commit, commit.slice(0, 12))
        : current,
    text,
  )
}

function exemptEvidenceSpans(text: string): SecretSpan[] {
  return regexSpans(EXEMPT_EVIDENCE_TOKEN, text)
}

function sameSpan(left: SecretSpan, right: SecretSpan): boolean {
  return left.start === right.start && left.end === right.end
}

/** Abbreviates caller-known commits, then masks only credential-shaped spans. */
export function redactSecretShaped(
  text: string,
  options: { knownCommits?: readonly string[]; exemptEvidenceTokens?: boolean } = {},
): { text: string; rules: string[] } {
  const prepared = abbreviateKnownCommits(text, options.knownCommits ?? [])
  const exemptions = options.exemptEvidenceTokens ? exemptEvidenceSpans(prepared) : []
  const ruleSpans = RULES.map((rule) => ({
    rule,
    spans: rule
      .spans(prepared)
      .filter((span) => !exemptions.some((exemption) => sameSpan(span, exemption))),
  }))
  const rules = ruleSpans.filter(({ spans }) => spans.length > 0).map(({ rule }) => rule.name)
  const spans = ruleSpans
    .flatMap(({ rule, spans }, ruleIndex) =>
      spans.map((span) => ({ ...span, rule: rule.name, ruleIndex })),
    )
    .sort((left, right) => left.start - right.start || left.ruleIndex - right.ruleIndex)
  const merged: typeof spans = []
  for (const span of spans) {
    const previous = merged.at(-1)
    if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end)
    else merged.push({ ...span })
  }
  let cursor = 0
  let redacted = ''
  for (const span of merged) {
    redacted += `${prepared.slice(cursor, span.start)}${withheldMarker(span.rule)}`
    cursor = span.end
  }
  return { text: redacted + prepared.slice(cursor), rules }
}

/** Keeps child-process detail out of prompts and logs when it resembles credentials. */
export function withholdSecretShapedDetail(text: string): string {
  const redacted = redactSecretShaped(text)
  if (redacted.rules.length > 0) return redacted.text
  return /\b(?:proxy-)?authorization\b/i.test(text)
    ? text.replace(/\b(?:proxy-)?authorization\b[^\r\n]*/gi, withheldMarker('authorization'))
    : text
}

function jwtHeaderIsObject(token: string): boolean {
  const dot = token.indexOf('.')
  if (dot < 1) return false
  try {
    const json = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

function base64RunIsSecret(run: string): boolean {
  const bytes = decodedBase64Bytes(run)
  if (bytes === null || bytes < table.base64MinBytes) return false
  if (/[+=]/.test(run)) return true
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run)
}

function decodedBase64Bytes(text: string): number | null {
  const normalized = text.replaceAll('-', '+').replaceAll('_', '/')
  const padded = `${normalized}${'='.repeat((4 - (normalized.length % 4)) % 4)}`
  if (padded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) return null
  const buf = Buffer.from(padded, 'base64')
  if (buf.toString('base64').replace(/=+$/, '') !== padded.replace(/=+$/, '')) return null
  return buf.length
}
