import { expect, test } from 'bun:test'
import { decideHostedSpaceOpen } from './hosted-secret-opening.ts'

const space = '01990000-0000-7000-8000-000000000001'
const user = '01990000-0000-7000-8000-000000000002'
const membership = { spaceId: space, slug: 'alpha', permission: 'write' }
const machine = { userId: user, revokedAt: null }

test('destination-space opening requires membership, config access, and a live machine key', () => {
  expect(
    decideHostedSpaceOpen({
      destinationSpaceId: space,
      userId: user,
      memberships: [membership],
      configAccess: true,
      machine,
    }),
  ).toEqual({ allowed: true, identity: { spaceId: space, userId: user } })
  expect(
    decideHostedSpaceOpen({
      destinationSpaceId: space,
      userId: user,
      memberships: [membership],
      configAccess: false,
      machine,
    }),
  ).toEqual({ allowed: false, reason: 'no-config-access' })
  expect(
    decideHostedSpaceOpen({
      destinationSpaceId: space,
      userId: user,
      memberships: [membership],
      configAccess: true,
      machine: { ...machine, revokedAt: '2026-11-08T00:00:00.000Z' },
    }),
  ).toEqual({ allowed: false, reason: 'machine-not-trusted' })
})

test('a project destination never substitutes membership from another space', () => {
  expect(
    decideHostedSpaceOpen({
      destinationSpaceId: space,
      userId: user,
      memberships: [{ ...membership, spaceId: '01990000-0000-7000-8000-000000000003' }],
      configAccess: true,
      machine,
    }),
  ).toEqual({ allowed: false, reason: 'not-member' })
})
