import { afterEach, expect, test } from 'bun:test'
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
  KEY_SIZE,
  sealClaimChallenge,
  wrapDataKey,
} from '../../../shared/secret-envelope.ts'
import { pinTrustedMachine } from '../../../shared/trust-list.ts'
import { claimCurrentMachineKey, listSecrets, machineRevoke, setSecret } from './config-service.ts'
import { rotationFixture } from './config-service-rotation.fixture.ts'
import { secretSetRemedy } from './secret-set-policy.ts'

const roots: string[] = []
const previousConfigHome = process.env.BOTTEGA_CONFIG_HOME
const previousKeystore = process.env.BOTTEGA_KEYSTORE
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (previousConfigHome === undefined) delete process.env.BOTTEGA_CONFIG_HOME
  else process.env.BOTTEGA_CONFIG_HOME = previousConfigHome
  if (previousKeystore === undefined) delete process.env.BOTTEGA_KEYSTORE
  else process.env.BOTTEGA_KEYSTORE = previousKeystore
})

async function destinationDataKeyFixture(hasCurrentDataKey: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'config-destination-data-key-'))
  roots.push(root)
  process.env.BOTTEGA_CONFIG_HOME = root
  process.env.BOTTEGA_KEYSTORE = 'file'
  const activeSpaceId = '01990000-0000-7000-8000-000000000011'
  const destinationSpaceId = '01990000-0000-7000-8000-000000000012'
  const userId = '01990000-0000-7000-8000-000000000013'
  writeHostedConfigIdentity({ spaceId: activeSpaceId, userId })
  const pair = await generateMachineKeyPair()
  writeMachineKey(pair)
  const keyId = await machineKeyId(pair.publicKey)
  await pinTrustedMachine(keyId, pair.publicKey, 'current')
  const dek = generateDataKey()
  const dekId = '01990000-0000-7000-8000-000000000014'
  const wrapped = await wrapDataKey({
    dek,
    wrapContext: { spaceId: destinationSpaceId, dekId, dekVersion: 1 },
    senderPrivateKey: pair.privateKey,
    senderPublicKey: pair.publicKey,
    recipientPublicKey: pair.publicKey,
  })
  const existing = {
    id: dekId,
    version: 1,
    createdAt: '2026-11-15T00:00:00.000Z',
    retiredAt: null,
    wraps: [
      {
        recipientKeyId: keyId,
        senderKeyId: keyId,
        enc: Buffer.from(wrapped.enc).toString('base64url'),
        ciphertext: Buffer.from(wrapped.ciphertext).toString('base64url'),
      },
    ],
  }
  let created: Parameters<ConfigClient['createDataKey']>[0] | undefined
  const calls = {
    create: [] as string[],
    get: [] as string[],
    machineKeys: [] as string[],
    trustLog: [] as string[],
  }
  let stored: Record<string, unknown> | undefined
  const client = {
    whoami: async () => ({ user: { id: userId }, activeSpaceId, memberships: [] }),
    currentDataKey: async () => {
      if (!hasCurrentDataKey)
        throw new ConfigClientError('response', '/v1/config/data-keys/current', 404)
      return existing
    },
    readTrustLog: async (destination: { destinationSpaceId?: string }) => {
      calls.trustLog.push(destination.destinationSpaceId ?? '')
      return []
    },
    listMachineKeys: async (destination: { destinationSpaceId?: string }) => {
      calls.machineKeys.push(destination.destinationSpaceId ?? '')
      return [{ keyId, revokedAt: null }]
    },
    createDataKey: async (
      input: Parameters<ConfigClient['createDataKey']>[0],
      destination: Parameters<ConfigClient['createDataKey']>[1],
    ) => {
      created = input
      calls.create.push(destination.destinationSpaceId)
      return { id: input.dekId, version: input.version }
    },
    getDataKey: async (
      _id: string,
      _recipientKeyId: string,
      destination: { destinationSpaceId?: string },
    ) => {
      calls.get.push(destination.destinationSpaceId ?? '')
      return {
        ...existing,
        id: created?.dekId ?? existing.id,
        wraps: created?.wraps ?? existing.wraps,
      }
    },
    getSecret: async () => {
      if (stored) return stored
      throw new ConfigClientError('response', '/v1/config/secrets/TOKEN', 404)
    },
    putSecret: async (key: string, input: Record<string, unknown>) => {
      stored = {
        ...input,
        key,
        rowVersion: 1,
        updatedAt: '2026-11-18T00:00:00.000Z',
      }
      return stored
    },
    listSecrets: async () => [],
    listDataKeys: async () => [existing],
  } as unknown as ConfigClient
  return { client, calls, created: () => created, destinationSpaceId, keyId }
}

test('a first write to space B creates and reads its data key in B and wraps for B trust', async () => {
  const fixture = await destinationDataKeyFixture(false)

  await setSecret('TOKEN', 'value', 'space', fixture.client, {
    destination: { destinationSpaceId: fixture.destinationSpaceId },
    remedy: secretSetRemedy('TOKEN', 'space'),
  })

  expect(fixture.calls.create).toEqual([fixture.destinationSpaceId])
  expect(fixture.calls.get).toEqual([fixture.destinationSpaceId])
  expect(fixture.calls.trustLog).toEqual([fixture.destinationSpaceId])
  expect(fixture.calls.machineKeys).toEqual([
    fixture.destinationSpaceId,
    fixture.destinationSpaceId,
  ])
  expect(fixture.created()?.wraps.map((wrap) => wrap.recipientKeyId)).toEqual([fixture.keyId])
})

test('a write to space B reads machine-key revocations from B', async () => {
  const fixture = await destinationDataKeyFixture(true)

  await setSecret('TOKEN', 'value', 'space', fixture.client, {
    destination: { destinationSpaceId: fixture.destinationSpaceId },
    remedy: secretSetRemedy('TOKEN', 'space'),
  })

  expect(fixture.calls.machineKeys).toEqual([fixture.destinationSpaceId])
})

test('secret list names the pinned space instead of relying on the active tenant default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'config-list-destination-'))
  roots.push(root)
  const env = { BOTTEGA_CONFIG_HOME: root, BOTTEGA_KEYSTORE: 'file' }
  const spaceId = '01990000-0000-7000-8000-000000000031'
  const userId = '01990000-0000-7000-8000-000000000032'
  writeHostedConfigIdentity({ spaceId, userId }, env)
  const destinations: string[] = []
  const client = {
    whoami: async () => ({ user: { id: userId }, activeSpaceId: spaceId }),
    listSecrets: async (_environment: string, destination: { destinationSpaceId?: string }) => {
      destinations.push(destination.destinationSpaceId ?? '')
      return []
    },
  } as unknown as ConfigClient

  await listSecrets(client, env)
  expect(destinations).toEqual([spaceId])
})

test('secret set refuses success when its destination cannot read the written row back', async () => {
  const fixture = await destinationDataKeyFixture(true)
  fixture.client.putSecret = async (key, input) => ({
    ...input,
    key,
    rowVersion: 1,
    updatedAt: '2026-11-18T00:00:00.000Z',
  })

  await expect(
    setSecret('TOKEN', 'value', 'space', fixture.client, {
      destination: { destinationSpaceId: fixture.destinationSpaceId },
      remedy: secretSetRemedy('TOKEN', 'space'),
    }),
  ).rejects.toThrow(
    `wrote TOKEN in space ${fixture.destinationSpaceId} but could not read that row back from space ${fixture.destinationSpaceId}`,
  )
})

test('machine revoke sends wrap and revoke writes to the same active space', async () => {
  const fixture = await rotationFixture(roots, null, false, false, false, false, true)

  await machineRevoke(fixture.otherKeyId, fixture.client)

  expect(fixture.addWrapDestinations).toEqual([fixture.spaceId])
  expect(fixture.revokeDestinations).toEqual([fixture.spaceId])
})

test('claim current machine key sends its challenge and claim to the active space', async () => {
  const root = mkdtempSync(join(tmpdir(), 'config-claim-destination-'))
  roots.push(root)
  const env = { BOTTEGA_CONFIG_HOME: root, BOTTEGA_KEYSTORE: 'file' }
  const activeSpaceId = '01990000-0000-7000-8000-000000000021'
  const pair = await generateMachineKeyPair()
  writeMachineKey(pair, env)
  const keyId = await machineKeyId(pair.publicKey)
  const sender = await generateMachineKeyPair()
  const nonce = crypto.getRandomValues(new Uint8Array(KEY_SIZE))
  const destinations = { challenge: [] as string[], claim: [] as string[] }
  const client = {
    listMachineKeys: async () => [{ keyId, userId: null }],
    whoami: async () => ({ user: { id: 'user-a' }, activeSpaceId }),
    createMachineKeyClaimChallenge: async (
      recipientKeyId: string,
      destination: { destinationSpaceId?: string },
    ) => {
      destinations.challenge.push(destination.destinationSpaceId ?? '')
      const sealed = await sealClaimChallenge({
        nonce,
        spaceId: activeSpaceId,
        keyId: recipientKeyId,
        senderPrivateKey: sender.privateKey,
        senderPublicKey: sender.publicKey,
        recipientPublicKey: pair.publicKey,
      })
      return {
        challengeId: 'claim-destination',
        enc: Buffer.from(sealed.enc).toString('base64url'),
        ciphertext: Buffer.from(sealed.ciphertext).toString('base64url'),
        senderPublicKey: Buffer.from(sender.publicKey).toString('base64url'),
      }
    },
    claimMachineKey: async (
      _keyId: string,
      _challengeId: string,
      _opened: string,
      destination: { destinationSpaceId?: string },
    ) => {
      destinations.claim.push(destination.destinationSpaceId ?? '')
      return { claimed: true as const }
    },
  } as unknown as ConfigClient

  await claimCurrentMachineKey(client, env)

  expect(destinations.challenge).toEqual([activeSpaceId])
  expect(destinations.claim).toEqual([activeSpaceId])
})
