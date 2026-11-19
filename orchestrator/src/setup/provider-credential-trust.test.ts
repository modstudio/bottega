import { expect, test } from 'bun:test'
import type { ConfigClient } from '../../../shared/config-client.ts'
import type { CredentialMachine } from '../../../shared/credential-machine-trust.ts'
import type { Project } from '../project/projects.ts'
import {
  type GatherProviderCredentialTrustDependencies,
  gatherProviderCredentialTrustFacts,
} from './provider-credential-trust.ts'

const machine: CredentialMachine = { keyId: 'test-key', publicKey: new Uint8Array([1, 2, 3]) }
const agent = [{ enabled: true, provider: 'openrouter' }]
const project = (space?: string) =>
  ({
    name: 'test',
    recordId: 'project-id',
    path: '/test',
    stack: null,
    canon: false,
    retiredAt: null,
    settings: space ? { space } : {},
  }) as Project

function client(overrides: Partial<ConfigClient> = {}): ConfigClient {
  return {
    whoami: async () => ({
      user: { id: 'user-id' },
      activeSpaceId: 'space-id',
      memberships: [{ space_id: 'space-id', slug: 'studio', permission: 'write' }],
    }),
    listMachineKeys: async () => [],
    readTrustLog: async () => [],
    ...overrides,
  } as ConfigClient
}

function deps(overrides: Partial<GatherProviderCredentialTrustDependencies> = {}) {
  return {
    sessionToken: () => 'session',
    machine: () => machine,
    client: () => client(),
    ...overrides,
  }
}

test('provider credential trust gathering skips inapplicable local states', async () => {
  expect(await gatherProviderCredentialTrustFacts([], [project('studio')], deps())).toEqual([])
  expect(
    await gatherProviderCredentialTrustFacts(
      agent,
      [project('studio')],
      deps({ sessionToken: () => null }),
    ),
  ).toEqual([])
  expect(await gatherProviderCredentialTrustFacts(agent, [project()], deps())).toEqual([])
})

test('provider credential trust gathering reports missing and throwing local reads', async () => {
  expect(
    await gatherProviderCredentialTrustFacts(
      agent,
      [project('studio')],
      deps({ machine: () => null }),
    ),
  ).toEqual([
    { status: 'could-not-check', space: 'studio', reason: 'machine key is not initialized' },
  ])
  expect(
    await gatherProviderCredentialTrustFacts(
      agent,
      [project('studio')],
      deps({
        sessionToken: () => {
          throw new Error('session failed')
        },
      }),
    ),
  ).toEqual([{ status: 'could-not-check', space: 'studio', reason: 'session failed' }])
  expect(
    await gatherProviderCredentialTrustFacts(
      agent,
      [project('studio')],
      deps({
        machine: () => {
          throw new Error('key failed')
        },
      }),
    ),
  ).toEqual([{ status: 'could-not-check', space: 'studio', reason: 'key failed' }])
})

test('provider credential trust gathering reports whoami, membership and trust-read failures', async () => {
  const twoProjects = [project('studio'), project('other')]
  expect(
    await gatherProviderCredentialTrustFacts(
      agent,
      twoProjects,
      deps({
        client: () =>
          client({
            whoami: async () => {
              throw new Error('whoami failed')
            },
          }),
      }),
    ),
  ).toEqual([
    { status: 'could-not-check', space: 'studio', reason: 'whoami failed' },
    { status: 'could-not-check', space: 'other', reason: 'whoami failed' },
  ])
  expect(await gatherProviderCredentialTrustFacts(agent, [project('other')], deps())).toEqual([
    {
      status: 'could-not-check',
      space: 'other',
      reason: 'the signed-in user is not a member of that space',
    },
  ])
  expect(
    await gatherProviderCredentialTrustFacts(
      agent,
      [project('studio')],
      deps({
        client: () =>
          client({
            listMachineKeys: async () => {
              throw new Error('read failed')
            },
          }),
      }),
    ),
  ).toEqual([{ status: 'could-not-check', space: 'studio', reason: 'read failed' }])
})

test('provider credential trust gathering returns checked facts for a matching row', async () => {
  expect(
    await gatherProviderCredentialTrustFacts(
      agent,
      [project('studio')],
      deps({
        client: () =>
          client({ listMachineKeys: async () => [{ keyId: machine.keyId, revokedAt: null }] }),
      }),
    ),
  ).toEqual([
    {
      status: 'checked',
      registered: true,
      revoked: false,
      trusted: false,
      space: 'studio',
      keyId: 'test-key',
      publicKey: 'AQID',
    },
  ])
})
