import { expect, test } from 'bun:test'
import { redactSecretShaped } from './secret-shaped.ts'
import corpus from './secret-shaped-parity.json'

const PEM_BEGIN = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
const PEM_END = ['-----END ', 'PRIVATE KEY-----'].join('')

function expandPemPlaceholders(text: string): string {
  return text.replaceAll('{PEM_BEGIN}', PEM_BEGIN).replaceAll('{PEM_END}', PEM_END)
}

test.each(corpus)('$name has the shared redaction result', (fixture) => {
  expect(
    redactSecretShaped(expandPemPlaceholders(fixture.input), {
      exemptEvidenceTokens: fixture.exemptEvidenceTokens,
    }),
  ).toEqual({
    text: expandPemPlaceholders(fixture.text),
    rules: fixture.rules,
  })
})
