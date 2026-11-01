import { expect, test } from 'bun:test'
import { redactSecretShapedOutput } from './secret-shaped-output.ts'

const hex40 = 'a'.repeat(40)
const githubPat = 'ghp_123456789012345678901234567890123456'

test('a 40-hex sha line and failure list survive', () => {
  expect(
    redactSecretShapedOutput(`--base=${hex40}\ngate failures: scripts/check-architecture.ts`, [
      hex40,
    ]),
  ).toBe(`--base=${hex40.slice(0, 12)}\ngate failures: scripts/check-architecture.ts`)
})

test('an unrelated 64-hex output value is withheld', () => {
  expect(redactSecretShapedOutput('b'.repeat(64), [hex40])).toBe('[withheld: hex-run]')
})

test('output withholds only the secret-shaped line and names the rule', () => {
  expect(
    redactSecretShapedOutput(
      ['gate failures: scripts/check-architecture.ts', githubPat, 'ok'].join('\n'),
    ),
  ).toBe(
    ['gate failures: scripts/check-architecture.ts', '[withheld: provider-prefix]', 'ok'].join(
      '\n',
    ),
  )
})
