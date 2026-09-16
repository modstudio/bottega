import { describe, expect, test } from 'bun:test'
import { type RecordMembership, recordSpaceRole, resolveRecordSpace } from './record-space.ts'

const memberships: RecordMembership[] = [
  { spaceId: 'space-b', slug: 'beta', name: 'Beta', role: 'member', permission: 'write' },
  { spaceId: 'space-a', slug: 'alpha', name: 'Alpha', role: 'owner', permission: 'write' },
]

describe('record space decisions', () => {
  test('resolves only the signed-in user memberships by slug or id', () => {
    expect(resolveRecordSpace('alpha', memberships).spaceId).toBe('space-a')
    expect(resolveRecordSpace('space-b', memberships).slug).toBe('beta')
    expect(() => resolveRecordSpace('other', memberships)).toThrow(
      "record space other is not one of the user's memberships; available slugs: alpha, beta",
    )
  })

  test('accepts only supported invitation roles', () => {
    expect(recordSpaceRole('member')).toBe('member')
    expect(recordSpaceRole('owner')).toBe('owner')
    expect(() => recordSpaceRole('operator')).toThrow('must be member or owner')
  })
})
