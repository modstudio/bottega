import { describe, expect, test } from 'bun:test'
import { overturnRulingDecision } from './ruling-overturn-authority.ts'

const decide = (overrides: Partial<Parameters<typeof overturnRulingDecision>[0]> = {}) =>
  overturnRulingDecision({
    answeredAt: '2026-09-20T12:00:00.000Z',
    overturnedAt: null,
    owner: 'owner-session',
    actor: 'owner-session',
    ...overrides,
  })

describe('overturn ruling decision', () => {
  test('allows the owning session and an actor on an unowned chain', () => {
    expect(decide()).toEqual({ kind: 'allow' })
    expect(decide({ owner: null, actor: 'new-owner' })).toEqual({ kind: 'allow' })
  })

  test('refuses unanswered and already-overturned questions', () => {
    expect(decide({ answeredAt: null })).toEqual({ kind: 'refuse', code: 'unanswered' })
    expect(decide({ overturnedAt: '2026-09-21T12:00:00.000Z' })).toEqual({
      kind: 'refuse',
      code: 'already-overturned',
    })
  })

  test('refuses a session other than the chain owner', () => {
    expect(decide({ actor: 'other-session' })).toEqual({
      kind: 'refuse',
      code: 'owner-mismatch',
    })
  })
})
