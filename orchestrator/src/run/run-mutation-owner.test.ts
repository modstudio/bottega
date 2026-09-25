import { describe, expect, test } from 'bun:test'
import { runMutationOwnerDecision } from './run-mutation-owner.ts'

describe('run mutation owner decision', () => {
  test('allows the owning session and an actor on an unowned chain', () => {
    expect(runMutationOwnerDecision({ owner: 'owner-session', actor: 'owner-session' })).toEqual({
      kind: 'allow',
    })
    expect(runMutationOwnerDecision({ owner: null, actor: 'new-owner' })).toEqual({ kind: 'allow' })
  })

  test('refuses a session other than the chain owner', () => {
    expect(runMutationOwnerDecision({ owner: 'owner-session', actor: 'other-session' })).toEqual({
      kind: 'refuse',
      code: 'owner-mismatch',
    })
  })
})
