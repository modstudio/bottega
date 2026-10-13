import { describe, expect, test } from 'bun:test'
import {
  recordMembershipsFromIdentity,
  recordSpaceRole,
  refuseDuplicateRecordSpaceSlug,
} from './record-space.ts'

describe('record space decisions', () => {
  test('maps whoami memberships into the rows printed by space list', () => {
    expect(
      recordMembershipsFromIdentity({
        user: { id: 'user-a' },
        activeSpaceId: 'space-b',
        personalSpaceId: 'space-a',
        memberships: [
          { space_id: 'space-b', name: 'Beta', slug: 'beta', role: 'member', permission: 'read' },
          { space_id: 'space-a', name: 'Alpha', slug: 'alpha', role: 'owner', permission: 'write' },
        ],
      }),
    ).toEqual({
      activeSpaceId: 'space-b',
      memberships: [
        { spaceId: 'space-a', name: 'Alpha', slug: 'alpha', role: 'owner', permission: 'write' },
        { spaceId: 'space-b', name: 'Beta', slug: 'beta', role: 'member', permission: 'read' },
      ],
    })
  })
  test('accepts only supported invitation roles', () => {
    expect(recordSpaceRole('member')).toBe('member')
    expect(recordSpaceRole('admin')).toBe('admin')
    expect(recordSpaceRole('owner')).toBe('owner')
    expect(() => recordSpaceRole('operator')).toThrow('must be member, admin, or owner')
  })

  test('refuses creating a second space with the same slug and names the existing id', () => {
    expect(() =>
      refuseDuplicateRecordSpaceSlug('team', [
        {
          spaceId: '01990000-0000-7000-8000-000000000003',
          slug: 'team',
          name: 'Team',
          role: 'owner',
          permission: 'write',
        },
      ]),
    ).toThrow('record space slug team already exists: 01990000-0000-7000-8000-000000000003')
  })

  test('refuses a slug shaped like a record id and names the ambiguity', () => {
    const slug = '01990000-0000-7000-8000-000000000003'
    expect(() => refuseDuplicateRecordSpaceSlug(slug, [])).toThrow(
      `record space slug ${slug} is shaped like a record id and would make space selection ambiguous`,
    )
  })

  test('refuses a padded slug shaped like a record id', () => {
    const slug = '  01990000-0000-7000-8000-000000000003  '
    expect(() => refuseDuplicateRecordSpaceSlug(slug, [])).toThrow(
      'is shaped like a record id and would make space selection ambiguous',
    )
  })
})
