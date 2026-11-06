import { expect, test } from 'bun:test'
import type { OrganizationMember } from '@bottega/hub-data/hosted-organization'
import { joinMembersToConfigAccess } from './members.tsx'

const members: OrganizationMember[] = [
  {
    id: 'member-1',
    userId: 'user-1',
    organizationId: 'space-1',
    role: 'owner',
    user: { name: 'Ada', email: 'Ada@example.com' },
  },
  {
    id: 'member-2',
    userId: 'user-2',
    organizationId: 'space-1',
    role: 'member',
    user: { name: 'Grace', email: 'grace@example.com' },
  },
  {
    id: 'member-3',
    userId: 'user-3',
    organizationId: 'space-1',
    role: 'member',
    user: { name: 'Lin', email: 'lin@example.com' },
  },
]

test('joins member access by email and marks a missing access row', () => {
  const rows = joinMembersToConfigAccess(members, [
    {
      email: 'ada@example.com',
      role: 'owner',
      permission: 'write',
      configAccess: true,
    },
    { email: 'lin@example.com', role: 'member', permission: 'read', configAccess: false },
  ])

  expect(
    rows.map(({ permission, permissionLabel, configAccessLabel, configAccess }) => ({
      permission,
      permissionLabel,
      configAccessLabel,
      configAccess,
    })),
  ).toEqual([
    { permission: 'write', permissionLabel: 'Write', configAccessLabel: 'Yes', configAccess: true },
    { permission: null, permissionLabel: '-', configAccessLabel: '-', configAccess: null },
    { permission: 'read', permissionLabel: 'Read', configAccessLabel: 'No', configAccess: false },
  ])
})
