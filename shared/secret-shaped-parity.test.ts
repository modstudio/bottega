import { expect, test } from 'bun:test'
import { redactSecretShaped } from './secret-shaped.ts'
import corpus from './secret-shaped-parity.json'

const PEM_BEGIN = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
const PEM_END = ['-----END ', 'PRIVATE KEY-----'].join('')

function expandPemPlaceholders(text: string): string {
  return text.replaceAll('{PEM_BEGIN}', PEM_BEGIN).replaceAll('{PEM_END}', PEM_END)
}

test.each(corpus)('$name has the shared redaction result', (fixture) => {
  const input = fixture.inputParts?.join('') ?? fixture.input
  if (input === undefined) throw new Error(`${fixture.name}: parity fixture has no input`)
  expect(
    redactSecretShaped(expandPemPlaceholders(input), {
      exemptEvidenceTokens: fixture.exemptEvidenceTokens,
    }),
  ).toEqual({
    text: expandPemPlaceholders(fixture.text),
    rules: fixture.rules,
  })
})
