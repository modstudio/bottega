import { expect, test } from 'bun:test'
import { requestTenant } from './record-api-tenant.ts'
import type { RecordIdentity } from './record-auth.ts'

const identity = (activeSpaceId: string): RecordIdentity => ({
  user: { id: 'user-a', email: 'a@example.test' },
  activeSpaceId,
  personalSpaceId: 'space-personal',
  memberships: [
    {
      space_id: 'space-personal',
      name: 'Personal',
      slug: 'personal',
      role: 'owner',
      permission: 'write',
    },
    {
      space_id: 'space-project',
      name: 'Project',
      slug: 'project',
      role: 'member',
      permission: 'write',
    },
  ],
})

test('request tenant reads use the named destination when one is supplied', () => {
  expect(
    requestTenant(identity('space-personal'), 'space-project', 'read', 'postgres://record'),
  ).toEqual({
    url: 'postgres://record',
    userId: 'user-a',
    personalSpaceId: 'space-personal',
    spaceId: 'space-project',
    spaceIds: ['space-project'],
  })
})

test('request tenant reads use the personal lens over every membership', () => {
  expect(requestTenant(identity('space-personal'), undefined, 'read', 'postgres://record')).toEqual(
    {
      url: 'postgres://record',
      userId: 'user-a',
      personalSpaceId: 'space-personal',
      spaceId: 'space-personal',
      spaceIds: ['space-personal', 'space-project'],
    },
  )
})

test('request tenant reads otherwise use only the active space', () => {
  expect(requestTenant(identity('space-project'), undefined, 'read', 'postgres://record')).toEqual({
    url: 'postgres://record',
    userId: 'user-a',
    personalSpaceId: 'space-personal',
    spaceId: 'space-project',
    spaceIds: ['space-project'],
  })
})

test('request tenant refuses a write without a named destination', () => {
  expect(requestTenant(identity('space-project'), undefined, 'write', 'postgres://record')).toEqual(
    {
      refused: 'write-destination',
    },
  )
})
