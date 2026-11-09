import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import { writeHostedConfigIdentity } from '../../../shared/hosted-config-space.ts'
import { machineKeyId } from '../../../shared/machine-key-id.ts'
import { writeMachineKey } from '../../../shared/machine-key-store.ts'
import {
  generateDataKey,
  generateMachineKeyPair,
  sealValue,
  wrapDataKey,
} from '../../../shared/secret-envelope.ts'
import { pinTrustedMachine } from '../../../shared/trust-list.ts'
import {
  type CredentialAddress,
  deleteCredential,
  operatorProjectCredentialAddress,
  projectCredentialAddress,
  projectHasCredential,
  resolveCredentialValue,
  resolveProjectOperatorCredential,
  setCredential,
} from './credential-service.ts'

test('project credential address matches credential resolve project defaults', async () => {
  const projectId = crypto.randomUUID()
  const spaceId = crypto.randomUUID()
  const target = await projectCredentialAddress(
    { name: 'starship', recordId: projectId, settings: {} },
    'openrouter',
    {
      whoami: async () => ({
        user: { id: crypto.randomUUID() },
        activeSpaceId: spaceId,
        memberships: [{ space_id: spaceId, slug: 'team', permission: 'write' }],
      }),
    } as ConfigClient,
  )
  expect(target).toEqual({
    provider: 'openrouter',
    name: null,
    type: 'api-key',
    mode: 'default',
    environment: 'local',
    payer: 'personal',
    projectId,
    projectName: 'starship',
    spaceName: 'team',
    destinationSpaceId: spaceId,
  })
})

test('project credential address refuses missing record identity with project push remedy', async () => {
  await expect(
    projectCredentialAddress({ name: 'starship', recordId: null, settings: {} }, 'openrouter'),
  ).rejects.toThrow(`${PLATFORM_SLUG} project push`)
})

let root: string
let previousConfigHome: string | undefined
let previousKeystore: string | undefined
let pair: Awaited<ReturnType<typeof generateMachineKeyPair>>

beforeEach(async () => {
  previousConfigHome = process.env.BOTTEGA_CONFIG_HOME
  previousKeystore = process.env.BOTTEGA_KEYSTORE
  root = mkdtempSync(join(tmpdir(), 'credential-service-'))
  process.env.BOTTEGA_CONFIG_HOME = root
  process.env.BOTTEGA_KEYSTORE = 'file'
  pair = await generateMachineKeyPair()
  writeMachineKey(pair)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  if (previousConfigHome === undefined) delete process.env.BOTTEGA_CONFIG_HOME
  else process.env.BOTTEGA_CONFIG_HOME = previousConfigHome
  if (previousKeystore === undefined) delete process.env.BOTTEGA_KEYSTORE
  else process.env.BOTTEGA_KEYSTORE = previousKeystore
})

const address: CredentialAddress = {
  provider: 'openrouter',
  name: null,
  type: 'api-key',
  mode: 'default',
  environment: 'local',
  payer: 'personal',
  projectId: '01990000-0000-7000-8000-000000000001',
  projectName: 'alpha',
  spaceName: 'studio',
  destinationSpaceId: '01990000-0000-7000-8000-000000000002',
}

const project = {
  name: 'alpha',
  recordId: '01990000-0000-7000-8000-000000000001',
  settings: {},
}
const identity = { provider: address.provider, name: address.name, type: address.type }

function metadataRow(
  projectId: string | null,
  name: string | null = address.name,
  type: string = address.type,
) {
  return {
    key: `row-${projectId ?? 'space'}-${name ?? 'unnamed'}-${type}`,
    scope: 'user' as const,
    projectId,
    environment: address.environment,
    provider: address.provider,
    name,
    type,
    hint: '4 characters',
    mode: address.mode,
    dekId: '01990000-0000-7000-8000-000000000004',
    rowVersion: 1,
    updatedAt: '2026-11-08T00:00:00.000Z',
  }
}

function metadataClient(rows: ReturnType<typeof metadataRow>[]): ConfigClient {
  return {
    whoami: async () => ({
      user: { id: '01990000-0000-7000-8000-000000000003' },
      activeSpaceId: address.destinationSpaceId,
      memberships: [
        { space_id: address.destinationSpaceId, slug: address.spaceName, permission: 'write' },
      ],
    }),
    listSecrets: async () => rows,
    listCredentialPreferences: async () => [],
    getSecret: async () => {
      throw new Error('metadata observation must not open a credential value')
    },
    getDataKey: async () => {
      throw new Error('metadata observation must not open a credential value')
    },
  } as unknown as ConfigClient
}

test('operator identity replaces identity fields and retains project binding fields', () => {
  expect(
    operatorProjectCredentialAddress(address, {
      provider: 'fly',
      name: 'metrics',
      type: 'token',
    }),
  ).toEqual({
    ...address,
    provider: 'fly',
    name: 'metrics',
    type: 'token',
  })
})

test('set credential gives the project access remedy for every missing wrap outcome', async () => {
  for (const currentDataKey of [
    async () => {
      throw new ConfigClientError('response', '/v1/config/data-keys/current', 404)
    },
    async () => ({
      id: '01990000-0000-7000-8000-000000000003',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      retiredAt: null,
      wraps: [],
    }),
  ]) {
    const createDataKey = mock(async () => ({ id: '', version: 1 }))
    const client = { currentDataKey, createDataKey } as unknown as ConfigClient
    await expect(setCredential(address, 'secret', client)).rejects.toThrow(
      'machine config machine trust',
    )
    expect(createDataKey).not.toHaveBeenCalled()
  }
})

test('set credential refuses a blank value with the credential remedy before writing', async () => {
  const putSecret = mock(async () => ({}))
  const client = { putSecret } as unknown as ConfigClient

  await expect(setCredential(address, '', client)).rejects.toThrow(
    'credential set openrouter/api-key --project alpha',
  )
  expect(putSecret).not.toHaveBeenCalled()
})

test('set credential writes a project-bound row with its metadata and hint', async () => {
  const keyId = await machineKeyId(pair.publicKey)
  await pinTrustedMachine(keyId, pair.publicKey, 'current')
  writeHostedConfigIdentity({
    spaceId: address.destinationSpaceId,
    userId: '01990000-0000-7000-8000-000000000003',
  })
  const dekId = '01990000-0000-7000-8000-000000000004'
  const dek = generateDataKey()
  const wrapped = await wrapDataKey({
    dek,
    wrapContext: { spaceId: address.destinationSpaceId, dekId, dekVersion: 1 },
    senderPrivateKey: pair.privateKey,
    senderPublicKey: pair.publicKey,
    recipientPublicKey: pair.publicKey,
  })
  const encode = (value: Uint8Array) => Buffer.from(value).toString('base64url')
  const putSecret = mock(async (_key: string, input: object) => input)
  const client = {
    currentDataKey: async () => ({
      id: dekId,
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      retiredAt: null,
      wraps: [
        {
          recipientKeyId: keyId,
          senderKeyId: keyId,
          enc: encode(wrapped.enc),
          ciphertext: encode(wrapped.ciphertext),
        },
      ],
    }),
    getSecret: async () => {
      throw new ConfigClientError('response', '/v1/config/secrets/OPENROUTER_API_KEY', 404)
    },
    whoami: async () => ({
      user: { id: '01990000-0000-7000-8000-000000000003' },
      activeSpaceId: address.destinationSpaceId,
    }),
    putSecret,
  } as unknown as ConfigClient

  await setCredential(address, 'abcd-credential-value-wxyz', client)

  expect(putSecret).toHaveBeenCalledTimes(1)
  expect(putSecret.mock.calls[0]?.[0]).toBe('openrouter/api-key#default@local')
  expect(putSecret.mock.calls[0]?.[1]).toMatchObject({
    destinationSpaceId: address.destinationSpaceId,
    projectId: address.projectId,
    provider: address.provider,
    name: address.name,
    type: address.type,
    mode: address.mode,
    environment: address.environment,
    hint: 'abcd…wxyz',
  })
})

test('delete credential explains how to recreate an absent project credential', async () => {
  const client = {
    getSecret: async () => {
      throw new ConfigClientError('response', '/v1/config/secrets/OPENROUTER_API_KEY', 404)
    },
  } as unknown as ConfigClient
  await expect(deleteCredential(address, client)).rejects.toThrow(
    'credential set openrouter/api-key --project alpha',
  )
})

test('service and operator resolution return the selected payer row value', async () => {
  const userId = '01990000-0000-7000-8000-000000000003'
  const dekId = '01990000-0000-7000-8000-000000000004'
  const keyId = await machineKeyId(pair.publicKey)
  await pinTrustedMachine(keyId, pair.publicKey, 'current')
  writeHostedConfigIdentity({ spaceId: address.destinationSpaceId, userId })
  const dek = generateDataKey()
  const wrapped = await wrapDataKey({
    dek,
    wrapContext: { spaceId: address.destinationSpaceId, dekId, dekVersion: 1 },
    senderPrivateKey: pair.privateKey,
    senderPublicKey: pair.publicKey,
    recipientPublicKey: pair.publicKey,
  })
  const encode = (value: Uint8Array) => Buffer.from(value).toString('base64url')
  const row = (key: string, scope: 'user' | 'space', projectId: string | null, value: string) => ({
    key,
    scope,
    projectId,
    environment: address.environment,
    provider: address.provider,
    name: address.name,
    type: address.type,
    hint: '4 characters',
    mode: address.mode,
    dekId,
    rowVersion: 1,
    updatedAt: '2026-11-08T00:00:00.000Z',
    envelope: encode(
      sealValue({
        dek,
        plaintext: new TextEncoder().encode(value),
        valueContext: {
          spaceId: address.destinationSpaceId,
          userId: scope === 'user' ? userId : null,
          keyName: key,
          environment: address.environment,
          dekId,
          rowVersion: 1,
        },
      }),
    ),
  })
  const personal = row('personal-row', 'user', address.projectId, 'personal-value')
  const shared = row('shared-row', 'space', null, 'shared-value')
  let preferences: object[] = []
  const getSecret = mock(async (key: string) => {
    const selected = [personal, shared].find((candidate) => candidate.key === key)
    if (!selected) throw new Error(`unexpected secret ${key}`)
    return selected
  })
  const client = {
    listSecrets: async () => [personal, shared],
    listCredentialPreferences: async () => preferences,
    getSecret,
    getDataKey: async () => ({
      id: dekId,
      version: 1,
      createdAt: '2026-11-08T00:00:00.000Z',
      retiredAt: null,
      wraps: [
        {
          recipientKeyId: keyId,
          senderKeyId: keyId,
          enc: encode(wrapped.enc),
          ciphertext: encode(wrapped.ciphertext),
        },
      ],
    }),
    whoami: async () => ({
      user: { id: userId },
      activeSpaceId: address.destinationSpaceId,
      memberships: [
        { space_id: address.destinationSpaceId, slug: address.spaceName, permission: 'write' },
      ],
    }),
    listMachineKeys: async () => [
      {
        keyId,
        publicKey: encode(pair.publicKey),
        label: 'current',
        createdAt: '2026-11-08T00:00:00.000Z',
        revokedAt: null,
        userId,
      },
    ],
  } as unknown as ConfigClient

  expect((await resolveCredentialValue(address, client)).value).toBe('personal-value')
  expect(await resolveProjectOperatorCredential(project, identity, client)).toBe('personal-value')

  preferences = [
    {
      projectId: address.projectId,
      provider: address.provider,
      name: address.name,
      type: address.type,
      mode: address.mode,
      environment: address.environment,
      payer: 'shared',
      binding: 'space',
    },
  ]
  expect((await resolveCredentialValue(address, client)).value).toBe('shared-value')
})

test('operator resolution returns undefined when no credential matches', async () => {
  expect(
    await resolveProjectOperatorCredential(project, identity, metadataClient([])),
  ).toBeUndefined()
})

test('operator resolution propagates a client failure', async () => {
  const client = metadataClient([])
  client.listSecrets = async () => {
    throw new Error('host unavailable')
  }
  await expect(resolveProjectOperatorCredential(project, identity, client)).rejects.toThrow(
    'host unavailable',
  )
})

test('credential presence resolves a project-bound row from metadata only', async () => {
  expect(
    await projectHasCredential(project, identity, metadataClient([metadataRow(address.projectId)])),
  ).toBe(true)
})

test('credential presence resolves a space-bound row from metadata only', async () => {
  expect(await projectHasCredential(project, identity, metadataClient([metadataRow(null)]))).toBe(
    true,
  )
})

test('credential presence rejects a row with a different name', async () => {
  expect(
    await projectHasCredential(project, identity, metadataClient([metadataRow(null, 'other')])),
  ).toBe(false)
})

test('operator presence matches the named identity rather than the project default', async () => {
  const named = { provider: address.provider, name: 'metrics', type: 'token' }
  const defaultRow = metadataRow(address.projectId)
  expect(await projectHasCredential(project, named, metadataClient([defaultRow]))).toBe(false)
  expect(
    await projectHasCredential(
      project,
      named,
      metadataClient([defaultRow, metadataRow(address.projectId, 'metrics', 'token')]),
    ),
  ).toBe(true)
  expect(
    await resolveProjectOperatorCredential(project, named, metadataClient([defaultRow])),
  ).toBeUndefined()
})
