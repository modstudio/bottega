import { describe, expect, test } from 'bun:test'
import { RECORD_ACTIVE_SPACE_REMEDY } from '../../../shared/record-remedies.ts'
import { activeSpaceInvariant } from './active-space-invariant.ts'

const memberships = [
  { spaceId: 'space-a', slug: 'alpha' },
  { spaceId: 'space-b', slug: 'beta' },
]

describe('active space invariant', () => {
  test('holds for an active membership and an intended-space match', () => {
    expect(activeSpaceInvariant({ activeSpaceId: 'space-a', memberships })).toEqual({
      holds: true,
      active: memberships[0]!,
    })
    expect(
      activeSpaceInvariant({ activeSpaceId: 'space-b', memberships, intendedSpaceId: 'space-b' }),
    ).toEqual({ holds: true, active: memberships[1]! })
  })

  test('treats no memberships as no space', () => {
    expect(activeSpaceInvariant({ activeSpaceId: 'stale', memberships: [] })).toEqual({
      holds: true,
      active: null,
    })
  })

  test('refuses an absent membership and an intended-space mismatch', () => {
    expect(activeSpaceInvariant({ activeSpaceId: 'outside', memberships }).holds).toBe(false)
    const mismatch = activeSpaceInvariant({
      activeSpaceId: 'space-a',
      memberships,
      intendedSpaceId: 'space-b',
    })
    expect(mismatch.holds).toBe(false)
    if (!mismatch.holds) {
      expect(mismatch.message).toContain('active space space-a')
      expect(mismatch.message).toContain('intended space space-b')
      expect(mismatch.message).toContain(RECORD_ACTIVE_SPACE_REMEDY)
    }
  })
})
