import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import { writeHostedConfigIdentity } from '../../../shared/hosted-config-space.ts'
import { machineKeyId } from '../../../shared/machine-key-id.ts'
import { writeMachineKey } from '../../../shared/machine-key-store.ts'
import {
  generateDataKey,
  generateMachineKeyPair,
  wrapDataKey,
} from '../../../shared/secret-envelope.ts'
import { pinTrustedMachine } from '../../../shared/trust-list.ts'
import { type CredentialAddress, deleteCredential, setCredential } from './credential-service.ts'

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
    await expect(setCredential(address, 'secret', client)).rejects.toThrow('record space switch')
    await expect(setCredential(address, 'secret', client)).rejects.toThrow(
      'record space access grant',
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
