import { expect, test } from 'bun:test'
import { validateTriageOverride } from './override-decision.ts'

test('triage override requires operator attribution', () => {
  expect(() => validateTriageOverride('urgent', false)).toThrow('--from-operator')
  expect(validateTriageOverride(' urgent ', true)).toBe('urgent')
  expect(validateTriageOverride(undefined, false)).toBeNull()
})
