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
]

test('joins member access by email and marks a missing access row', () => {
  const rows = joinMembersToConfigAccess(members, [
    {
      email: 'ada@example.com',
      role: 'owner',
      permission: 'write',
      configAccess: true,
    },
  ])

  expect(
    rows.map(({ permissionLabel, configAccessLabel, configAccess }) => ({
      permissionLabel,
      configAccessLabel,
      configAccess,
    })),
  ).toEqual([
    { permissionLabel: 'Write', configAccessLabel: 'Yes', configAccess: true },
    { permissionLabel: '-', configAccessLabel: '-', configAccess: null },
  ])
})
