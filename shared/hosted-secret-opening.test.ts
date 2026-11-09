import { expect, test } from 'bun:test'
import {
  decideHostedSpaceOpen,
  destinationHostedIdentity,
  hostedSecretIdentityKind,
} from './hosted-secret-opening.ts'

const space = '01990000-0000-7000-8000-000000000001'
const user = '01990000-0000-7000-8000-000000000002'
const membership = { spaceId: space, slug: 'alpha', permission: 'write' }
const machine = { userId: user, revokedAt: null }

test('an absent destination uses the active-space identity', () => {
  expect(hostedSecretIdentityKind(undefined, space)).toBe('active')
})

test('the pinned space destination uses the active-space identity', () => {
  expect(hostedSecretIdentityKind(space, space)).toBe('active')
})

test('a different destination uses the destination identity', () => {
  expect(hostedSecretIdentityKind('01990000-0000-7000-8000-000000000003', space)).toBe(
    'destination',
  )
})

test('destination-space opening requires a live machine key owned by the signed-in user', () => {
  expect(
    decideHostedSpaceOpen({
      destinationSpaceId: space,
      userId: user,
      machine,
    }),
  ).toEqual({ allowed: true, identity: { spaceId: space, userId: user } })
  expect(
    decideHostedSpaceOpen({
      destinationSpaceId: space,
      userId: user,
      machine: { ...machine, revokedAt: '2026-11-08T00:00:00.000Z' },
    }),
  ).toEqual({ allowed: false, reason: 'machine-not-trusted' })
})

test('a project destination never consults machine keys in another space', async () => {
  let listed = false
  const client = {
    whoami: async () => ({
      user: { id: user },
      activeSpaceId: '01990000-0000-7000-8000-000000000003',
      memberships: [
        {
          space_id: '01990000-0000-7000-8000-000000000003',
          slug: membership.slug,
          permission: membership.permission,
        },
      ],
    }),
    listMachineKeys: async () => {
      listed = true
      return []
    },
  } as never
  await expect(
    destinationHostedIdentity(
      client,
      { spaceId: space, machineKeyId: 'machine' },
      { spaceId: space, userId: user },
    ),
  ).rejects.toThrow('not a member')
  expect(listed).toBe(false)
})
