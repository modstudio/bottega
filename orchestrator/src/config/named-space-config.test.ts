import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import {
  readHostedConfigIdentity,
  writeHostedConfigIdentity,
} from '../../../shared/hosted-config-space.ts'
import { machineKeyId } from '../../../shared/machine-key-id.ts'
import { writeMachineKey } from '../../../shared/machine-key-store.ts'
import {
  generateDataKey,
  generateMachineKeyPair,
  KEY_SIZE,
  sealClaimChallenge,
  unwrapDataKey,
  wrapDataKey,
} from '../../../shared/secret-envelope.ts'
import { pinTrustedMachine } from '../../../shared/trust-list.ts'
import { machineRegister, machineTrustInSpace } from './named-space-config.ts'

const namedSpaceId = '01990000-0000-7000-8000-000000000101'
const activeSpaceId = '01990000-0000-7000-8000-000000000102'
const userId = '01990000-0000-7000-8000-000000000103'
const pinnedUserId = userId
const namedSpace = { spaceId: namedSpaceId, slug: 'named' }
const activeSpace = { spaceId: activeSpaceId, slug: 'active' }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'named-space-config-'))
  roots.push(root)
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

async function wrappedDataKey(
  spaceId: string,
  keyId: string,
  pair: { publicKey: Uint8Array; privateKey: Uint8Array },
) {
  const dek = generateDataKey()
  const id = '01990000-0000-7000-8000-000000000104'
  const wrapped = await wrapDataKey({
    dek,
    wrapContext: { spaceId, dekId: id, dekVersion: 1 },
    senderPrivateKey: pair.privateKey,
    senderPublicKey: pair.publicKey,
    recipientPublicKey: pair.publicKey,
  })
  return {
    dek,
    key: {
      id,
      version: 1,
      createdAt: '2026-11-09T00:00:00.000Z',
      retiredAt: null,
      wraps: [
        {
          recipientKeyId: keyId,
          senderKeyId: keyId,
          enc: Buffer.from(wrapped.enc).toString('base64url'),
          ciphertext: Buffer.from(wrapped.ciphertext).toString('base64url'),
        },
      ],
    },
  }
}

test('named-space registration claims an unowned key with the named space identity', async () => {
  const { env, identity, keyId, pair } = await fixture()
  const originalPin = readHostedConfigIdentity(env)
  const sender = await generateMachineKeyPair()
  const nonce = crypto.getRandomValues(new Uint8Array(KEY_SIZE))
  const current = await wrappedDataKey(namedSpaceId, keyId, pair)
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
      return current.key
    },
  } as unknown as ConfigClient

  await expect(machineRegister(namedSpace, 'fixture', client, env)).resolves.toEqual([
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

  await expect(machineRegister(namedSpace, 'fixture', client, env)).resolves.toEqual([
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

  await expect(machineRegister(namedSpace, 'fixture', client, env)).rejects.toThrow(
    `machine config machine trust ${keyId} ${publicKey} --space named`,
  )
})

test('trust in a named space routes every call and posts a wrap sealed for that space', async () => {
  const { env, identity, keyId, pair } = await fixture()
  const target = await generateMachineKeyPair()
  const targetKeyId = await machineKeyId(target.publicKey)
  const current = await wrappedDataKey(namedSpaceId, keyId, pair)
  const destinations: Array<string | undefined> = []
  let posted: Parameters<ConfigClient['addWraps']>[1] | undefined
  const client = {
    whoami: async () => identity,
    listMachineKeys: async (destination: { destinationSpaceId?: string }) => {
      destinations.push(destination.destinationSpaceId)
      return [{ keyId: targetKeyId, revokedAt: null }]
    },
    currentDataKey: async (_keyId: string, destination: { destinationSpaceId?: string }) => {
      destinations.push(destination.destinationSpaceId)
      return current.key
    },
    addWraps: async (
      _dekId: string,
      wraps: Parameters<ConfigClient['addWraps']>[1],
      destination: { destinationSpaceId?: string },
    ) => {
      destinations.push(destination.destinationSpaceId)
      posted = wraps
      return { added: wraps.length }
    },
  } as unknown as ConfigClient

  await machineTrustInSpace(
    targetKeyId,
    Buffer.from(target.publicKey).toString('base64url'),
    'target',
    namedSpace,
    client,
    env,
  )

  expect(destinations).toEqual([namedSpaceId, namedSpaceId, namedSpaceId])
  expect(posted).toHaveLength(1)
  const wrap = posted![0]!
  await expect(
    unwrapDataKey({
      enc: new Uint8Array(Buffer.from(wrap.enc, 'base64url')),
      ciphertext: new Uint8Array(Buffer.from(wrap.ciphertext, 'base64url')),
      wrapContext: {
        spaceId: namedSpaceId,
        dekId: current.key.id,
        dekVersion: current.key.version,
      },
      recipientPrivateKey: target.privateKey,
      senderPublicKey: pair.publicKey,
      trustedSenderKeyIds: new Set([keyId]),
    }),
  ).resolves.toEqual(current.dek)
})

test('trust in a named space refuses when the space has no data key', async () => {
  const { env, identity } = await fixture()
  const target = await generateMachineKeyPair()
  const targetKeyId = await machineKeyId(target.publicKey)
  let addWrapsCalls = 0
  const client = {
    whoami: async () => identity,
    listMachineKeys: async () => [{ keyId: targetKeyId, revokedAt: null }],
    currentDataKey: async () => {
      throw new ConfigClientError('response', '/v1/config/data-keys/current', 404)
    },
    addWraps: async () => {
      addWrapsCalls += 1
    },
  } as unknown as ConfigClient

  await expect(
    machineTrustInSpace(
      targetKeyId,
      Buffer.from(target.publicKey).toString('base64url'),
      'target',
      namedSpace,
      client,
      env,
    ),
  ).rejects.toThrow(
    `record space named has no data key yet, so there is nothing to wrap; run \`${PLATFORM_SLUG} machine config machine register --space named\` on this machine to create it, then run this trust again`,
  )
  expect(addWrapsCalls).toBe(0)
})

test('registration uses the explicitly selected active destination and leaves pinned identity unchanged', async () => {
  const { env, identity, keyId, pair } = await fixture()
  const originalPin = readHostedConfigIdentity(env)
  const current = await wrappedDataKey(activeSpaceId, keyId, pair)
  const destinations: Array<string | undefined> = []
  const client = {
    whoami: async () => identity,
    listMachineKeys: async (destination: { destinationSpaceId?: string }) => {
      destinations.push(destination.destinationSpaceId)
      return [{ keyId }]
    },
    registerMachineKey: async (
      _keyId: string,
      _publicKey: string,
      _label: string,
      destination: { destinationSpaceId?: string },
    ) => {
      destinations.push(destination.destinationSpaceId)
      return { userId }
    },
    currentDataKey: async (_keyId: string, destination: { destinationSpaceId?: string }) => {
      destinations.push(destination.destinationSpaceId)
      return current.key
    },
  } as unknown as ConfigClient

  await expect(machineRegister(activeSpace, 'fixture', client, env)).resolves.toEqual([
    'already registered',
    'data key opened',
  ])
  expect(destinations).toEqual([activeSpaceId, activeSpaceId, activeSpaceId])
  expect(readHostedConfigIdentity(env)).toEqual(originalPin)
})

test("registration refuses when the data key wrap's sender is not trusted", async () => {
  const { env, identity, keyId } = await fixture()
  const senderKeyId = 'untrusted-sender'
  const client = {
    whoami: async () => identity,
    listMachineKeys: async () => [{ keyId }],
    registerMachineKey: async () => ({ userId }),
    currentDataKey: async () => ({
      id: 'dek-untrusted',
      version: 1,
      createdAt: '2026-11-09T00:00:00.000Z',
      retiredAt: null,
      wraps: [
        {
          recipientKeyId: keyId,
          senderKeyId,
          enc: 'enc',
          ciphertext: 'ciphertext',
        },
      ],
    }),
  } as unknown as ConfigClient

  await expect(machineRegister(namedSpace, 'fixture', client, env)).rejects.toThrow(
    `data key dek-untrusted in record space named was wrapped by untrusted-sender, which this machine does not trust; pin it with \`${PLATFORM_SLUG} machine config machine trust untrusted-sender <publicKey> --space named\` using that machine's public key from \`${PLATFORM_SLUG} machine config machine show\``,
  )
})
