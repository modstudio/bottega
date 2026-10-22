import { expect, test } from 'bun:test'
import {
  containsSecretShaped,
  evidenceSecretShapedRules,
  secretShapedRule,
  withholdSecretShapedGateLines,
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

test('evidence variant exempts whole 40-hex, 64-hex, and UUID tokens', () => {
  expect(secretShapedRule(hex40)).toBe('hex-run')
  expect(secretShapedRule(hex64)).toBe('hex-run')
  expect(evidenceSecretShapedRules(hex40)).toEqual([])
  expect(evidenceSecretShapedRules(hex64)).toEqual([])
  expect(evidenceSecretShapedRules(uuid)).toEqual([])
  expect(containsSecretShaped(hex40)).toBe(true)
})

test('a token assignment that contains a hash-shaped value still matches', () => {
  expect(evidenceSecretShapedRules(`token=${hex40}`)[0]).toBe('assignment')
})

test('the evidence detector can report every matching rule', () => {
  expect(
    evidenceSecretShapedRules(`Bearer fixture ${'c'.repeat(32)} https://user:pass@host.example`),
  ).toEqual(['bearer', 'hex-run', 'url-userinfo'])
})

test('canonical secret fixtures stay aligned with non-TypeScript adapters', () => {
  for (const fixture of fixtures) {
    expect(containsSecretShaped(fixture.parts.join('')), fixture.name).toBe(fixture.secret)
  }
})

test('output with a 40-hex base and a failure list is kept verbatim', () => {
  const output = `--base=${hex40}\ngate failures: scripts/check-architecture.ts`
  expect(withholdSecretShapedGateLines(output)).toBe(output)
})

test('output withholds only the secret-shaped line and names the rule', () => {
  expect(
    withholdSecretShapedGateLines(
      ['gate failures: scripts/check-architecture.ts', githubPat, 'ok'].join('\n'),
    ),
  ).toBe(
    ['gate failures: scripts/check-architecture.ts', '[withheld line: provider-prefix]', 'ok'].join(
      '\n',
    ),
  )
})
