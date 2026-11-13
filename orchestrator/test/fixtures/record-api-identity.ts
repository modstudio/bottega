import type { RecordIdentity } from '../../src/record/record-auth.ts'

export const identity: RecordIdentity = {
  user: { id: 'user-a', email: 'a@example.test' },
  activeSpaceId: 'space-a',
  personalSpaceId: 'space-a',
  memberships: [
    { space_id: 'space-a', name: 'Space A', slug: 'space-a', role: 'owner', permission: 'write' },
  ],
}
