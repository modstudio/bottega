import { expect, test } from 'bun:test'
import { withholdSecretShapedGateLines } from './secret-shaped-output.ts'

const hex40 = 'a'.repeat(40)
const githubPat = 'ghp_123456789012345678901234567890123456'

test('a 40-hex line is withheld and a failure list survives', () => {
  expect(
    withholdSecretShapedGateLines(
      `--base=${hex40}\ngate failures: scripts/check-architecture.ts`,
    ),
  ).toBe(`[withheld line: hex-run]\ngate failures: scripts/check-architecture.ts`)
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

test('a ghp_ line and a 40-hex line are each withheld and the failure list is kept', () => {
  expect(
    withholdSecretShapedGateLines(
      [`--base=${hex40}`, 'gate failures: scripts/check-architecture.ts', githubPat].join('\n'),
    ),
  ).toBe(
    [
      '[withheld line: hex-run]',
      'gate failures: scripts/check-architecture.ts',
      '[withheld line: provider-prefix]',
    ].join('\n'),
  )
})
