import { expect, test } from 'bun:test'
import { answererKindFromAnsweredBy, rulingAttributionDecision } from './question-vocabulary.ts'

test('answered_by maps to the durable answerer kind used by the backfill', () => {
  expect(answererKindFromAnsweredBy(null)).toBeNull()
  expect(answererKindFromAnsweredBy('operator via orch-session')).toBe('operator')
  expect(answererKindFromAnsweredBy('canon-eval')).toBe('eval')
  expect(answererKindFromAnsweredBy('orch-session')).toBe('agent')
  expect(answererKindFromAnsweredBy('anonymous (no session id)')).toBe('agent')
})

test('ruling attribution supports mixed, whole-command, and conflicting forms', () => {
  expect(rulingAttributionDecision(false, false)).toEqual({
    kind: 'attribute',
    fromOperator: false,
  })
  expect(rulingAttributionDecision(false, true)).toEqual({
    kind: 'attribute',
    fromOperator: true,
  })
  expect(rulingAttributionDecision(true, false)).toEqual({
    kind: 'attribute',
    fromOperator: true,
  })
  expect(rulingAttributionDecision(true, true)).toEqual({
    kind: 'refuse',
    reason: expect.stringContaining('--from-operator-q<id>'),
  })
})
