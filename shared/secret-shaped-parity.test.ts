import { expect, test } from 'bun:test'
import { redactSecretShaped, validateSecretShapedRuleTable } from './secret-shaped.ts'
import corpus from './secret-shaped-parity.json'
import ruleTable from './secret-shaped-rules.json'

const PEM_BEGIN = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
const PEM_END = ['-----END ', 'PRIVATE KEY-----'].join('')

function expandPemPlaceholders(text: string): string {
  return text.replaceAll('{PEM_BEGIN}', PEM_BEGIN).replaceAll('{PEM_END}', PEM_END)
}

test.each(corpus.cases)('$name has the shared redaction result', (fixture) => {
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

type InvalidTableMutation = (typeof corpus.invalidTables)[number]

function invalidTable(mutation: InvalidTableMutation): unknown {
  const candidate = structuredClone(ruleTable) as unknown as Record<string, unknown>
  const target =
    mutation.target === 'rule'
      ? ((candidate.rules as Array<Record<string, unknown>>)[mutation.ruleIndex ?? 0] as Record<
          string,
          unknown
        >)
      : candidate
  if ('remove' in mutation && mutation.remove) delete target[mutation.field]
  else target[mutation.field] = mutation.value
  return candidate
}

test('the real rules table passes shared validation', () => {
  expect(() => validateSecretShapedRuleTable(ruleTable)).not.toThrow()
})

test.each(corpus.invalidTables)('$name is refused by shared validation', (mutation) => {
  expect(() => validateSecretShapedRuleTable(invalidTable(mutation))).toThrow()
})
