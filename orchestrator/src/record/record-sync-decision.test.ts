import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { RecordIdentity } from './record-auth.ts'
import {
  recordSyncAuthorizationDecision,
  recordSyncMachineOwnershipDecision,
} from './record-sync-decision.ts'

const identity: RecordIdentity = {
  user: { id: '01990000-0000-7000-8000-000000000001' },
  activeSpaceId: '01990000-0000-7000-8000-000000000002',
  personalSpaceId: '01990000-0000-7000-8000-000000000002',
  memberships: [
    {
      space_id: '01990000-0000-7000-8000-000000000002',
      slug: 'active',
      permission: 'write',
    },
    {
      space_id: '01990000-0000-7000-8000-000000000003',
      slug: 'read-only',
      permission: 'read',
    },
  ],
}

test('sync authorization derives user and fallback space only from the session identity', () => {
  expect(recordSyncAuthorizationDecision(identity, null)).toEqual({
    status: 'allowed',
    principal: {
      userId: identity.user.id,
      spaceId: '01990000-0000-7000-8000-000000000002',
    },
  })
  expect(recordSyncAuthorizationDecision(identity, 'read-only')).toMatchObject({
    status: 'deferred',
    spaceId: '01990000-0000-7000-8000-000000000003',
  })
  expect(recordSyncAuthorizationDecision(identity, 'active')).toEqual({
    status: 'allowed',
    principal: {
      userId: identity.user.id,
      spaceId: '01990000-0000-7000-8000-000000000002',
    },
  })
  expect(recordSyncAuthorizationDecision(identity, 'other')).toMatchObject({
    status: 'refused',
    reason: expect.stringContaining('not a member'),
  })
})

test('sync machine ownership permits registration and the owner but refuses another user', () => {
  const machineId = '01990000-0000-7000-8000-000000000004'
  expect(recordSyncMachineOwnershipDecision(machineId, null, identity.user.id)).toEqual({
    status: 'allowed',
  })
  expect(recordSyncMachineOwnershipDecision(machineId, identity.user.id, identity.user.id)).toEqual(
    { status: 'allowed' },
  )
  expect(
    recordSyncMachineOwnershipDecision(
      machineId,
      '01990000-0000-7000-8000-000000000005',
      identity.user.id,
    ),
  ).toEqual({
    status: 'refused',
    reason: `machine ${machineId} is registered to another user; sign in as the user that registered this machine, then retry \`${PLATFORM_SLUG} record sync\``,
  })
})
