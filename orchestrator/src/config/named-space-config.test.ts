import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import {
  readHostedConfigIdentity,
  writeHostedConfigIdentity,
} from '../../../shared/hosted-config-space.ts'
import { machineKeyId } from '../../../shared/machine-key-id.ts'
import { writeMachineKey } from '../../../shared/machine-key-store.ts'
import {
  generateMachineKeyPair,
  KEY_SIZE,
  sealClaimChallenge,
  unwrapDataKey,
} from '../../../shared/secret-envelope.ts'
import { pinTrustedMachine } from '../../../shared/trust-list.ts'
import { machineRegister } from './named-space-config.ts'

const namedSpaceId = '01990000-0000-7000-8000-000000000101'
const activeSpaceId = '01990000-0000-7000-8000-000000000102'
const userId = '01990000-0000-7000-8000-000000000103'
const pinnedUserId = userId
const roots: string[] = []
let previousConfigHome: string | undefined
let previousKeystore: string | undefined

beforeEach(() => {
  previousConfigHome = process.env.BOTTEGA_CONFIG_HOME
  previousKeystore = process.env.BOTTEGA_KEYSTORE
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (previousConfigHome === undefined) delete process.env.BOTTEGA_CONFIG_HOME
  else process.env.BOTTEGA_CONFIG_HOME = previousConfigHome
  if (previousKeystore === undefined) delete process.env.BOTTEGA_KEYSTORE
  else process.env.BOTTEGA_KEYSTORE = previousKeystore
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'named-space-config-'))
  roots.push(root)
  process.env.BOTTEGA_CONFIG_HOME = root
  process.env.BOTTEGA_KEYSTORE = 'file'
  const env = { BOTTEGA_CONFIG_HOME: root, BOTTEGA_KEYSTORE: 'file' }
  const pair = await generateMachineKeyPair()
  const keyId = await machineKeyId(pair.publicKey)
  writeMachineKey(pair, env)
  await pinTrustedMachine(keyId, pair.publicKey, 'fixture', env)
  writeHostedConfigIdentity({ spaceId: activeSpaceId, userId: pinnedUserId }, env)
  const identity = {
    user: { id: userId },
    activeSpaceId,
    personalSpaceId: null,
    memberships: [
      { space_id: activeSpaceId, slug: 'active', permission: 'write' },
      { space_id: namedSpaceId, slug: 'named', permission: 'write' },
    ],
  }
  return { env, identity, keyId, pair }
}

test('named-space registration claims an unowned key with the named space identity', async () => {
  const { env, identity, keyId, pair } = await fixture()
  const originalPin = readHostedConfigIdentity(env)
  const sender = await generateMachineKeyPair()
  const nonce = crypto.getRandomValues(new Uint8Array(KEY_SIZE))
  const destinations: Array<string | undefined> = []
  let claimed = false
  const client = {
    whoami: async () => identity,
    listMachineKeys: async (destination: { destinationSpaceId?: string }) => {
      destinations.push(destination.destinationSpaceId)
      return []
    },
    registerMachineKey: async (
      _keyId: string,
      _publicKey: string,
      _label: string,
      destination: { destinationSpaceId?: string },
    ) => {
      destinations.push(destination.destinationSpaceId)
      return { userId: null }
    },
    createMachineKeyClaimChallenge: async (
      challengedKeyId: string,
      destination: { destinationSpaceId?: string },
    ) => {
      destinations.push(destination.destinationSpaceId)
      const sealed = await sealClaimChallenge({
        nonce,
        spaceId: namedSpaceId,
        keyId: challengedKeyId,
        senderPrivateKey: sender.privateKey,
        senderPublicKey: sender.publicKey,
        recipientPublicKey: pair.publicKey,
      })
      return {
        challengeId: 'challenge',
        enc: Buffer.from(sealed.enc).toString('base64url'),
        ciphertext: Buffer.from(sealed.ciphertext).toString('base64url'),
        senderPublicKey: Buffer.from(sender.publicKey).toString('base64url'),
      }
    },
    claimMachineKey: async (
      claimedKeyId: string,
      challengeId: string,
      opened: string,
      destination: { destinationSpaceId?: string },
    ) => {
      destinations.push(destination.destinationSpaceId)
      expect(claimedKeyId).toBe(keyId)
      expect(challengeId).toBe('challenge')
      expect(new Uint8Array(Buffer.from(opened, 'base64url'))).toEqual(nonce)
      claimed = true
      return { claimed: true as const }
    },
    currentDataKey: async (_keyId: string, destination: { destinationSpaceId?: string }) => {
      destinations.push(destination.destinationSpaceId)
      return { wraps: [{}] }
    },
  } as unknown as ConfigClient

  await expect(machineRegister('named', 'fixture', client, env)).resolves.toEqual([
    'registered',
    'claimed',
    'data key opened',
  ])
  expect(claimed).toBe(true)
  expect(destinations.every((spaceId) => spaceId === namedSpaceId)).toBe(true)
  expect(readHostedConfigIdentity(env)).toEqual(originalPin)
})

test('named-space registration creates the first data key with named-space sealing and destination', async () => {
  const { env, identity, keyId, pair } = await fixture()
  let created:
    | {
        input: Parameters<ConfigClient['createDataKey']>[0]
        destination: Parameters<ConfigClient['createDataKey']>[1]
      }
    | undefined
  const machine = {
    keyId,
    publicKey: Buffer.from(pair.publicKey).toString('base64url'),
    label: 'fixture',
    createdAt: '2026-11-09T00:00:00.000Z',
    revokedAt: null,
    userId,
  }
  const client = {
    whoami: async () => identity,
    listMachineKeys: async () => [machine],
    registerMachineKey: async () => machine,
    currentDataKey: async () => {
      throw new ConfigClientError('response', '/v1/config/data-keys/current', 404)
    },
    createDataKey: async (
      input: Parameters<ConfigClient['createDataKey']>[0],
      destination: Parameters<ConfigClient['createDataKey']>[1],
    ) => {
      created = { input, destination }
      return { id: input.dekId, version: input.version }
    },
  } as unknown as ConfigClient

  await expect(machineRegister('named', 'fixture', client, env)).resolves.toEqual([
    'already registered',
    'data key created',
  ])
  expect(created?.destination).toEqual({ destinationSpaceId: namedSpaceId })
  expect(created?.input.wraps).toHaveLength(1)
  const wrap = created!.input.wraps[0]!
  await expect(
    unwrapDataKey({
      enc: new Uint8Array(Buffer.from(wrap.enc, 'base64url')),
      ciphertext: new Uint8Array(Buffer.from(wrap.ciphertext, 'base64url')),
      wrapContext: {
        spaceId: namedSpaceId,
        dekId: created!.input.dekId,
        dekVersion: created!.input.version,
      },
      recipientPrivateKey: pair.privateKey,
      senderPublicKey: pair.publicKey,
      trustedSenderKeyIds: new Set([keyId]),
    }),
  ).resolves.toHaveLength(32)
})

test('named-space registration refuses a current data key without this machine wrap', async () => {
  const { env, identity, keyId, pair } = await fixture()
  const publicKey = Buffer.from(pair.publicKey).toString('base64url')
  const client = {
    whoami: async () => identity,
    listMachineKeys: async () => [{ keyId }],
    registerMachineKey: async () => ({ userId }),
    currentDataKey: async () => ({ wraps: [] }),
  } as unknown as ConfigClient

  await expect(machineRegister('named', 'fixture', client, env)).rejects.toThrow(
    `machine config machine trust ${keyId} ${publicKey} --space named`,
  )
})
