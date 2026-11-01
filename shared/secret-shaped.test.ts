import { expect, test } from 'bun:test'
import {
  containsSecretShaped,
  redactSecretShaped,
  secretShapedRule,
  withholdSecretShapedDetail,
} from './secret-shaped.ts'
import fixtures from './secret-shaped-fixtures.json'

const hex40 = 'a'.repeat(40)
const hex64 = 'b'.repeat(64)
const uuid = '01990000-0000-7000-8000-000000000001'
const githubPat = 'ghp_123456789012345678901234567890123456'

function jwtSentinel(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub: '1' })).toString('base64url')
  const signature = Buffer.from('x'.repeat(32)).toString('base64url')
  return [header, payload, signature].join('.')
}

const named: Array<{ name: string; text: () => string }> = [
  { name: 'assignment', text: () => 'token=not-a-real-secret' },
  { name: 'bearer', text: () => ['Bearer ', 'z'.repeat(24)].join('') },
  { name: 'authorization', text: () => 'Authorization: secret-value' },
  { name: 'provider-prefix', text: () => githubPat },
  { name: 'hex-run', text: () => 'c'.repeat(32) },
  {
    name: 'url-userinfo',
    text: () => ['https://user', ':pass@', 'host.example'].join(''),
  },
  { name: 'pem', text: () => ['-----BEGIN ', 'PRIVATE KEY-----'].join('') },
  { name: 'jwt', text: jwtSentinel },
  { name: 'base64', text: () => Buffer.from('a'.repeat(20)).toString('base64') },
]

test.each(named)('secretShapedRule names $name', ({ name, text }) => {
  expect(secretShapedRule(text())).toBe(name)
  expect(containsSecretShaped(text())).toBe(true)
})

test('whole 40-hex and 64-hex tokens retain detection semantics', () => {
  expect(secretShapedRule(hex40)).toBe('hex-run')
  expect(secretShapedRule(hex64)).toBe('hex-run')
  expect(containsSecretShaped(hex40)).toBe(true)
  expect(containsSecretShaped(uuid)).toBe(false)
})

test('canonical secret fixtures stay aligned with non-TypeScript adapters', () => {
  for (const fixture of fixtures) {
    expect(containsSecretShaped(fixture.parts.join('')), fixture.name).toBe(fixture.secret)
  }
})

test('known commits are abbreviated before secret-shaped redaction', () => {
  expect(redactSecretShaped(`deployed ${hex40}`, { knownCommits: [hex40] })).toEqual({
    text: `deployed ${hex40.slice(0, 12)}`,
    rules: [],
  })
})

test('a digest is masked span-only and names hex-run', () => {
  expect(redactSecretShaped(`image digest sha256:${hex64} ready`)).toEqual({
    text: 'image digest sha256:[withheld: hex-run] ready',
    rules: ['hex-run'],
  })
})

test.each([
  ['40-hex commit', hex40],
  ['64-hex word', hex64],
  ['UUID', uuid],
] as const)('%s stays readable when evidence tokens are exempt', (_name, evidence) => {
  expect(
    redactSecretShaped(`evidence ${evidence} retained`, { exemptEvidenceTokens: true }),
  ).toEqual({
    text: `evidence ${evidence} retained`,
    rules: [],
  })
})

test('evidence exemption still masks a bearer token in the same text', () => {
  const bearer = `Bearer ${'z'.repeat(24)}`
  expect(redactSecretShaped(`${hex40} ${bearer}`, { exemptEvidenceTokens: true })).toEqual({
    text: `${hex40} [withheld: bearer]`,
    rules: ['bearer'],
  })
})

test.each([
  ['bearer', `request Bearer ${'z'.repeat(24)} complete`, 'request [withheld: bearer] complete'],
  [
    'url-userinfo',
    'fetch https://user:pass@host.example/path complete',
    'fetch [withheld: url-userinfo]host.example/path complete',
  ],
  ['jwt', `event ${jwtSentinel()} complete`, 'event [withheld: jwt] complete'],
] as const)('%s is masked span-only and named', (rule, text, expected) => {
  const redacted = redactSecretShaped(text)
  expect(redacted.text).toBe(expected)
  expect(redacted.rules).toContain(rule)
})

test('overlapping authorization and bearer spans are masked as one span', () => {
  expect(redactSecretShaped('failed Authorization: Bearer fixture-value after')).toEqual({
    text: 'failed [withheld: authorization]',
    rules: ['authorization', 'bearer'],
  })
})

test.each([
  ['Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
  ['Authorization: token abc123def', 'abc123def'],
  ['Proxy-Authorization: Basic X', 'X'],
] as const)('authorization redaction removes the full credential from %s', (header, credential) => {
  const redacted = redactSecretShaped(`before ${header}\nafter`)
  expect(redacted.text).toBe('before [withheld: authorization]\nafter')
  expect(redacted.text).not.toContain(credential)
})

const PEM_BEGIN = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
const PEM_END = ['-----END ', 'PRIVATE KEY-----'].join('')

test('PEM redaction removes the private-key block and preserves surrounding text', () => {
  const credential = 'dXNlcjpwYXNz'
  const pem = `before ${PEM_BEGIN}\n${credential}\n${PEM_END} after`
  const redacted = redactSecretShaped(pem)
  expect(redacted.text).toBe('before [withheld: pem] after')
  expect(redacted.text).not.toContain(credential)
})

test('an unterminated PEM redaction extends to the end of the text', () => {
  const credential = 'dXNlcjpwYXNz'
  const redacted = redactSecretShaped(`before ${PEM_BEGIN}\n${credential}`)
  expect(redacted.text).toBe('before [withheld: pem]')
  expect(redacted.text).not.toContain(credential)
})

test('authorization-word detail redaction removes the rest of its line', () => {
  const credential = 'abc123def'
  const redacted = withholdSecretShapedDetail(`before proxy-authorization ${credential}\nafter`)
  expect(redacted).toBe('before [withheld: authorization]\nafter')
  expect(redacted).not.toContain(credential)
})

test('text without a match is unchanged', () => {
  expect(redactSecretShaped('deployment complete')).toEqual({
    text: 'deployment complete',
    rules: [],
  })
})
