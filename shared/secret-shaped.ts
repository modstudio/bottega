// concern: secret-shaped
/** Detection and redaction of text that resembles credentials. */

const SECRET_ASSIGNMENT = /\b(?:token|key|secret|password)\s*=\s*\S+/gi
const SECRET_BEARER = /\bBearer\s+\S+/gi
const SECRET_AUTHORIZATION = /\b(?:Proxy-)?Authorization\s*[:=]\s*\S+[^\r\n]*/gi
const SECRET_TOKEN_PREFIX =
  /(?<![A-Za-z0-9])(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|sk-|xox[bposa]-|AKIA)\S*/g
const SECRET_HEX_RUN = /[0-9a-fA-F]{32,}/g
const SECRET_URL_USERINFO = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/g
const SECRET_PEM_PRIVATE_KEY = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----/g
const SECRET_JWT = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
const SECRET_BASE64_RUN = /[A-Za-z0-9+_-]{27,}={0,2}/g
const SECRET_BASE64_BYTES = 20
const EXEMPT_EVIDENCE_TOKEN =
  /(?<!sha256:)\b(?:[0-9a-f]{64}|[0-9a-f]{40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi

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

const pemSpans = (text: string): SecretSpan[] =>
  [...text.matchAll(SECRET_PEM_PRIVATE_KEY)].map((match) => {
    const endMarker = `-----END ${match[1]}-----`
    const endStart = text.indexOf(endMarker, match.index + match[0].length)
    return {
      start: match.index,
      end: endStart < 0 ? text.length : endStart + endMarker.length,
    }
  })

const RULES: readonly SecretRule[] = [
  { name: 'authorization', spans: (text) => regexSpans(SECRET_AUTHORIZATION, text) },
  { name: 'bearer', spans: (text) => regexSpans(SECRET_BEARER, text) },
  { name: 'assignment', spans: (text) => regexSpans(SECRET_ASSIGNMENT, text) },
  { name: 'provider-prefix', spans: (text) => regexSpans(SECRET_TOKEN_PREFIX, text) },
  { name: 'hex-run', spans: (text) => regexSpans(SECRET_HEX_RUN, text) },
  { name: 'url-userinfo', spans: (text) => regexSpans(SECRET_URL_USERINFO, text) },
  { name: 'pem', spans: pemSpans },
  { name: 'jwt', spans: (text) => filteredSpans(SECRET_JWT, text, jwtHeaderIsObject) },
  { name: 'base64', spans: (text) => filteredSpans(SECRET_BASE64_RUN, text, base64RunIsSecret) },
]

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
  if (bytes === null || bytes < SECRET_BASE64_BYTES) return false
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
