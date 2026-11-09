import { expect, mock, test } from 'bun:test'
import type { ConfigClient } from './config-client.ts'
import { resolveActiveSpaceCredentialValue, resolveHostedCredential } from './credential-value.ts'

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

test('hosted resolution lists the personal space once and tags its row as account-wide', async () => {
  const destinationSpaceId = 'space-a'
  const personalSpaceId = 'personal-space-a'
  const row = (scope: 'user' | 'space', reachSpaceIds: string[] | null = null) => ({
    key: `${scope}-row`,
    scope,
    environment: 'local',
    projectId: null,
    provider: 'typesafe',
    name: null,
    type: 'api-key',
    hint: '4 characters',
    mode: 'default',
    reachSpaceIds,
    dekId: 'dek-a',
    rowVersion: 1,
    updatedAt: '2026-11-09T00:00:00.000Z',
  })
  const account = row('user')
  const shared = row('space')
  const listed: string[] = []
  const client = {
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: destinationSpaceId,
      personalSpaceId,
      memberships: [],
    }),
    listSecrets: async (_environment: string, destination: { destinationSpaceId: string }) => {
      listed.push(destination.destinationSpaceId)
      return destination.destinationSpaceId === personalSpaceId ? [account] : [shared]
    },
    listCredentialPreferences: async () => [],
  } as unknown as ConfigClient
  const address = {
    provider: 'typesafe',
    name: null,
    type: 'api-key',
    mode: 'default' as const,
    environment: 'local' as const,
    projectId: null,
    spaceName: 'team',
    destinationSpaceId,
  }

  expect(await resolveHostedCredential(address, client)).toMatchObject({
    kind: 'resolved',
    reason: 'account',
    row: account,
    ownerSpaceId: personalSpaceId,
  })
  expect(listed).toEqual([destinationSpaceId, personalSpaceId])

  listed.length = 0
  expect(
    await resolveHostedCredential(
      { ...address, destinationSpaceId: personalSpaceId, spaceName: 'personal' },
      client,
    ),
  ).toMatchObject({ kind: 'resolved', reason: 'account', row: account })
  expect(listed).toEqual([personalSpaceId])

  account.reachSpaceIds = ['space-b']
  expect(await resolveHostedCredential(address, client)).toMatchObject({
    kind: 'resolved',
    reason: 'default-order',
    row: shared,
    ownerSpaceId: destinationSpaceId,
  })
})
