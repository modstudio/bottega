import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  createRecordSpace,
  pendingRecordInvitations,
  recordMembershipsFromIdentity,
  recordSpaceCreateReport,
  recordSpaceRole,
  refuseDuplicateRecordSpaceSlug,
  switchRecordSpace,
} from './record-space.ts'

describe('record space decisions', () => {
  test('returns active spaces from before and after creation', async () => {
    const identities = [
      {
        user: { id: 'user-a' },
        activeSpaceId: 'space-before',
        personalSpaceId: null,
        memberships: [
          {
            space_id: 'space-before',
            name: 'Before',
            slug: 'before',
            role: 'owner',
            permission: 'write',
          },
        ],
      },
      {
        user: { id: 'user-a' },
        activeSpaceId: 'space-created',
        personalSpaceId: null,
        memberships: [
          {
            space_id: 'space-created',
            name: 'Created',
            slug: 'created',
            role: 'owner',
            permission: 'write',
          },
        ],
      },
    ]
    let whoamiCall = 0
    expect(
      await createRecordSpace('Created', 'created', {
        whoami: async () => identities[whoamiCall++]!,
        createOrganization: async () => ({ id: 'space-created', slug: 'created' }),
      }),
    ).toEqual({
      id: 'space-created',
      slug: 'created',
      before: { id: 'space-before', slug: 'before' },
      after: { id: 'space-created', slug: 'created' },
    })
    expect(whoamiCall).toBe(2)
  })

  test('reports a switch to the created space and the command that restores the previous slug', () => {
    expect(
      recordSpaceCreateReport(
        { id: 'space-before', slug: 'before' },
        { id: 'space-created', slug: 'created' },
        { id: 'space-created', slug: 'created' },
      ),
    ).toEqual([
      'active record space switched from before to created for every lane on this machine',
      `switch back: ${PLATFORM_SLUG} record space switch before`,
    ])
  })

  test('reports the created space without undo when there was no previous active space', () => {
    expect(
      recordSpaceCreateReport(
        { id: null, slug: null },
        { id: 'space-created', slug: 'created' },
        { id: 'space-created', slug: 'created' },
      ),
    ).toEqual(['active record space is now created'])
  })

  test('uses the previous id when its slug cannot be resolved', () => {
    expect(
      recordSpaceCreateReport(
        { id: 'space-before', slug: null },
        { id: 'space-created', slug: 'created' },
        { id: 'space-created', slug: 'created' },
      ),
    ).toEqual([
      'active record space switched from space-before to created for every lane on this machine',
      `switch back: ${PLATFORM_SLUG} record space switch space-before`,
    ])
  })

  test('reports an unchanged active space by slug', () => {
    expect(
      recordSpaceCreateReport(
        { id: 'space-before', slug: 'before' },
        { id: 'space-before', slug: 'before' },
        { id: 'space-created', slug: 'created' },
      ),
    ).toEqual([
      'active record space unchanged: before',
      'created space created is not active',
      `switch to it: ${PLATFORM_SLUG} record space switch created`,
    ])
  })

  test('reports an unchanged active space when there is no active space', () => {
    expect(
      recordSpaceCreateReport(
        { id: null, slug: null },
        { id: null, slug: null },
        { id: 'space-created', slug: 'created' },
      ),
    ).toEqual([
      'active record space unchanged: none',
      'created space created is not active',
      `switch to it: ${PLATFORM_SLUG} record space switch created`,
    ])
  })

  test('reports the actual third space selected after creation', () => {
    expect(
      recordSpaceCreateReport(
        { id: 'space-before', slug: 'before' },
        { id: 'space-third', slug: 'third' },
        { id: 'space-created', slug: 'created' },
      ),
    ).toEqual([
      'active record space switched from before to third for every lane on this machine',
      `switch back: ${PLATFORM_SLUG} record space switch before`,
      'created space created is not active',
      `switch to it: ${PLATFORM_SLUG} record space switch created`,
    ])
  })

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
        {
          spaceId: 'space-a',
          name: 'Alpha',
          slug: 'alpha',
          role: 'owner',
          permission: 'write',
        },
        {
          spaceId: 'space-b',
          name: 'Beta',
          slug: 'beta',
          role: 'member',
          permission: 'read',
        },
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

  test('passes hosted invitations through with their ISO expiry', async () => {
    const invitations = [
      {
        id: 'invitation-a',
        spaceName: 'Team',
        spaceSlug: 'team',
        role: 'member',
        inviterEmail: 'owner@example.test',
        expiresAt: '2026-10-20T12:00:00.000Z',
      },
    ]
    expect(await pendingRecordInvitations({ listInvitations: async () => invitations })).toBe(
      invitations,
    )
  })

  test('switches only to a listed membership and sends its id', async () => {
    const calls: unknown[] = []
    let activeSpaceId: string | null = null
    const selected = await switchRecordSpace('team', {
      whoami: async () => ({
        user: { id: 'user-a' },
        activeSpaceId,
        personalSpaceId: null,
        memberships: [
          {
            space_id: 'space-a',
            name: 'Team',
            slug: 'team',
            role: 'member',
            permission: 'write',
          },
        ],
      }),
      setActiveOrganization: async (input) => {
        calls.push(input)
        activeSpaceId = input.organizationId
        return { id: 'space-a', slug: 'team' }
      },
    })
    expect(selected).toEqual({
      spaceId: 'space-a',
      name: 'Team',
      slug: 'team',
      role: 'member',
      permission: 'write',
    })
    expect(calls).toEqual([{ organizationId: 'space-a' }])
  })

  test('refuses a switch when whoami re-reads a different active space', async () => {
    await expect(
      switchRecordSpace('team', {
        whoami: async () => ({
          user: { id: 'user-a' },
          activeSpaceId: 'space-other',
          personalSpaceId: null,
          memberships: [
            {
              space_id: 'space-a',
              name: 'Team',
              slug: 'team',
              role: 'member',
              permission: 'write',
            },
            {
              space_id: 'space-other',
              name: 'Other',
              slug: 'other',
              role: 'member',
              permission: 'write',
            },
          ],
        }),
        setActiveOrganization: async () => ({ id: 'space-a', slug: 'team' }),
      }),
    ).rejects.toThrow('active space space-other is not valid; intended space space-a')
  })

  test('refuses a non-member without calling set-active and names the available slugs', async () => {
    let called = false
    const switched = switchRecordSpace('outsider', {
      whoami: async () => ({
        user: { id: 'user-a' },
        activeSpaceId: 'space-a',
        personalSpaceId: 'space-a',
        memberships: [
          {
            space_id: 'space-a',
            name: 'Team',
            slug: 'team',
            role: 'owner',
            permission: 'write',
          },
        ],
      }),
      setActiveOrganization: async () => {
        called = true
        return { id: 'space-a', slug: 'team' }
      },
    })
    await expect(switched).rejects.toThrow(
      "record space outsider is not one of the user's memberships; available slugs: team",
    )
    expect(called).toBe(false)
  })
})
