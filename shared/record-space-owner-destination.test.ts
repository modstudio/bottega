import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import {
  recordSpaceOwnerDestination,
  resolveRecordSpaceOwnerDestination,
} from './record-space-owner-destination.ts'

const memberships = [{ spaceId: 'space-id', slug: 'member-space', permission: 'write' }]

describe('recordSpaceOwnerDestination', () => {
  test('refuses a missing owner and names every accepted owner flag', () => {
    expect(
      recordSpaceOwnerDestination(
        'credential set',
        { project: undefined, account: false },
        ['project', 'account'],
        memberships,
      ),
    ).toEqual({
      kind: 'refused',
      remedy:
        'credential set writes to a record space and names none; pass --space <slug>, or --project <name>, or --account',
    })
  })

  test('refuses an unknown or non-member slug with the membership remedy', () => {
    expect(recordSpaceOwnerDestination('lens set', { space: 'outside' }, [], memberships)).toEqual({
      kind: 'refused',
      remedy: `the signed-in user is not a member of record space outside; an invitation from a member of that space is needed; list invitations with \`${PLATFORM_SLUG} record space invitations\`, then accept one with \`${PLATFORM_SLUG} record space accept <invitation-id>\``,
    })
  })

  test('returns the selected member space', () => {
    expect(
      recordSpaceOwnerDestination('lens set', { space: 'member-space' }, [], memberships),
    ).toEqual({
      kind: 'space',
      spaceId: 'space-id',
      slug: 'member-space',
    })
  })

  test.each([
    [{ project: 'fixture' }, 'project'],
    [{ account: true }, 'account'],
  ] as const)('leaves %s ownership to its adapter', (flags, owner) => {
    expect(recordSpaceOwnerDestination('credential set', flags, [], memberships)).toEqual({
      kind: 'other-owner',
      owner,
    })
  })
})

describe('resolveRecordSpaceOwnerDestination', () => {
  test('refuses a missing owner before loading memberships', async () => {
    let loads = 0
    await expect(
      resolveRecordSpaceOwnerDestination('workflow set', {}, [], async () => {
        loads += 1
        return memberships
      }),
    ).rejects.toThrow('--space <slug>')
    expect(loads).toBe(0)
  })

  test('resolves a member slug after loading memberships', async () => {
    await expect(
      resolveRecordSpaceOwnerDestination(
        'workflow set',
        { space: 'member-space' },
        [],
        async () => memberships,
      ),
    ).resolves.toEqual({ spaceId: 'space-id', slug: 'member-space' })
  })
})
