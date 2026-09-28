// concern: secret-shaped
/** Pure detection of text that resembles credentials. */

const SECRET_ASSIGNMENT = /\b(?:token|key|secret|password)\s*=\s*\S+/i
const SECRET_BEARER = /\bBearer\s+\S+/i
const SECRET_AUTHORIZATION = /\bAuthorization\s*[:=]\s*\S+/i
const SECRET_TOKEN_PREFIX =
  /(?<![A-Za-z0-9])(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|sk-|xox[bposa]-|AKIA)/
const SECRET_HEX_RUN = /[0-9a-fA-F]{32,}/
const SECRET_URL_USERINFO = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/
const SECRET_PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const SECRET_JWT = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
const SECRET_BASE64_RUN = /[A-Za-z0-9+_-]{27,}={0,2}/g
const SECRET_BASE64_BYTES = 20
const EXEMPT_EVIDENCE_TOKEN =
  /\b(?:[0-9a-f]{64}|[0-9a-f]{40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi

const RULES: Array<{ name: string; matches: (text: string) => boolean }> = [
  { name: 'authorization', matches: (text) => SECRET_AUTHORIZATION.test(text) },
  { name: 'bearer', matches: (text) => SECRET_BEARER.test(text) },
  { name: 'assignment', matches: (text) => SECRET_ASSIGNMENT.test(text) },
  { name: 'provider-prefix', matches: (text) => SECRET_TOKEN_PREFIX.test(text) },
  { name: 'hex-run', matches: (text) => SECRET_HEX_RUN.test(text) },
  { name: 'url-userinfo', matches: (text) => SECRET_URL_USERINFO.test(text) },
  { name: 'pem', matches: (text) => SECRET_PEM_PRIVATE_KEY.test(text) },
  { name: 'jwt', matches: containsJwt },
  { name: 'base64', matches: containsBase64Secret },
]

export function secretShapedRule(text: string): string | null {
  for (const rule of RULES) {
    if (rule.matches(text)) return rule.name
  }
  return null
}

export function evidenceSecretShapedRule(text: string): string | null {
  return secretShapedRule(text.replace(EXEMPT_EVIDENCE_TOKEN, '_'))
}

export function containsSecretShaped(text: string): boolean {
  return secretShapedRule(text) !== null
}

function containsJwt(text: string): boolean {
  for (const match of text.matchAll(SECRET_JWT)) {
    if (jwtHeaderIsObject(match[0])) return true
  }
  return false
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

function containsBase64Secret(text: string): boolean {
  for (const match of text.matchAll(SECRET_BASE64_RUN)) {
    if (base64RunIsSecret(match[0])) return true
  }
  return false
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
