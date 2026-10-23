import { expect, test } from 'bun:test'
import { withholdSecretShapedGateLines } from './secret-shaped-output.ts'

const hex40 = 'a'.repeat(40)
const githubPat = 'ghp_123456789012345678901234567890123456'

test('a 40-hex sha line and failure list survive', () => {
  expect(
    withholdSecretShapedGateLines(`--base=${hex40}\ngate failures: scripts/check-architecture.ts`),
  ).toBe(`--base=${hex40}\ngate failures: scripts/check-architecture.ts`)
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

test('a ghp_ line is withheld while a 40-hex sha and failure list are kept', () => {
  expect(
    withholdSecretShapedGateLines(
      [`--base=${hex40}`, 'gate failures: scripts/check-architecture.ts', githubPat].join('\n'),
    ),
  ).toBe(
    [
      `--base=${hex40}`,
      'gate failures: scripts/check-architecture.ts',
      '[withheld line: provider-prefix]',
    ].join('\n'),
  )
})
