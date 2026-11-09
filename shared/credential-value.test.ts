import { expect, mock, test } from 'bun:test'
import type { ConfigClient } from './config-client.ts'
import { resolveActiveSpaceCredentialValue } from './credential-value.ts'

test('active-space resolution refuses when the active space has no parsed membership', async () => {
  const listSecrets = mock(async () => [])
  const client = {
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'space-a',
      memberships: [{ space_id: 'space-b', slug: 'other', permission: 'read' }],
    }),
    listSecrets,
  } as unknown as ConfigClient

  await expect(
    resolveActiveSpaceCredentialValue(
      {
        provider: 'typesafe',
        name: null,
        type: 'api-key',
        mode: 'default',
        environment: 'local',
      },
      client,
    ),
  ).rejects.toThrow('not a member of record space space-a')
  expect(listSecrets).not.toHaveBeenCalled()
})
