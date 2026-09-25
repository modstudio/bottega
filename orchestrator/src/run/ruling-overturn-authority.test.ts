import { describe, expect, test } from 'bun:test'
import { overturnRulingDecision } from './ruling-overturn-authority.ts'

const decide = (overrides: Partial<Parameters<typeof overturnRulingDecision>[0]> = {}) =>
  overturnRulingDecision({
    answeredAt: '2026-09-20T12:00:00.000Z',
    overturnedAt: null,
    ...overrides,
  })

describe('overturn ruling decision', () => {
  test('allows an answered standing ruling', () => {
    expect(decide()).toEqual({ kind: 'allow' })
  })

  test('refuses unanswered and already-overturned questions', () => {
    expect(decide({ answeredAt: null })).toEqual({ kind: 'refuse', code: 'unanswered' })
    expect(decide({ overturnedAt: '2026-09-21T12:00:00.000Z' })).toEqual({
      kind: 'refuse',
      code: 'already-overturned',
    })
  })
})
