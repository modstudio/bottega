import { expect, test } from 'bun:test'
import { answererKindFromAnsweredBy } from './question-facts.ts'

test('answered_by maps to the durable answerer kind used by the backfill', () => {
  expect(answererKindFromAnsweredBy(null)).toBeNull()
  expect(answererKindFromAnsweredBy('operator via orch-session')).toBe('operator')
  expect(answererKindFromAnsweredBy('canon-eval')).toBe('eval')
  expect(answererKindFromAnsweredBy('orch-session')).toBe('agent')
  expect(answererKindFromAnsweredBy('anonymous (no session id)')).toBe('agent')
})
