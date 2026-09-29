import { describe, expect, test } from 'bun:test'
import { runMutationOwnerDecision } from './run-mutation-owner.ts'

describe('run mutation owner decision', () => {
  const facts = {
    owner: 'owner-session',
    actor: 'owner-session',
    ownerLastSeenAt: 900,
    chainLastActivityAt: 800,
    now: 1_000,
    windowMs: 200,
  }

  test('returns owner for the owning session and an unowned chain', () => {
    expect(runMutationOwnerDecision(facts)).toBe('owner')
    expect(runMutationOwnerDecision({ ...facts, owner: null, actor: 'new-owner' })).toBe('owner')
  })

  test('adopts when the owner and chain activity are outside the window', () => {
    expect(
      runMutationOwnerDecision({
        ...facts,
        actor: 'other-session',
        ownerLastSeenAt: 700,
        chainLastActivityAt: 700,
      }),
    ).toBe('adopt')
  })

  test('refuses when the owner was seen within the window', () => {
    expect(runMutationOwnerDecision({ ...facts, actor: 'other-session' })).toBe('refuse')
  })
})
