import { describe, expect, test } from 'bun:test'
import { destinationOwnedByCaller, requireCurrentMoveTotal } from './record-space-move.ts'

const memberships = [
  { spaceId: 'source-id', slug: 'source', name: 'Source', role: 'member', permission: 'write' },
  { spaceId: 'owned-id', slug: 'owned', name: 'Owned', role: 'owner', permission: 'write' },
]

describe('record project space move decisions', () => {
  test('requires the current dry-run total at confirmation time', () => {
    expect(() => requireCurrentMoveTotal(4, 5)).toThrow(
      'confirmation count 4 does not match current total 5; run the dry run again',
    )
    expect(() => requireCurrentMoveTotal(5, 5)).not.toThrow()
  })

  test('requires an owned destination and names remedies', () => {
    expect(() => destinationOwnedByCaller('source', memberships)).toThrow(
      'requires the owner role; ask its owner to promote the caller, then retry',
    )
    expect(() => destinationOwnedByCaller('missing', memberships)).toThrow(
      'does not exist or is not visible to the caller; create it or join it as owner, then retry',
    )
    expect(destinationOwnedByCaller('owned-id', memberships).slug).toBe('owned')
  })
})
