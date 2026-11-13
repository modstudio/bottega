import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConfigClient } from '../../../shared/config-client.ts'
import { readHostedConfigIdentity } from '../../../shared/hosted-config-space.ts'
import { readMachineKey, writeMachineKey } from '../../../shared/machine-key-store.ts'
import { readMachineSigningKey } from '../../../shared/machine-signing-key.ts'
import { generateMachineKeyPair } from '../../../shared/secret-envelope.ts'
import { readTrustList } from '../../../shared/trust-list.ts'
import { machineInit } from './config-service.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('machine init adds a signing key to an existing X25519 identity and registers it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-init-signing-'))
  roots.push(root)
  const env = { BOTTEGA_CONFIG_HOME: root, BOTTEGA_KEYSTORE: 'file' }
  const registrations: Array<{ keyId: string; signingPublicKey?: string }> = []
  const spaceId = '01990000-0000-7000-8000-000000000001'
  const userId = '01990000-0000-7000-8000-000000000002'
  const client = {
    whoami: async () => ({ user: { id: userId }, activeSpaceId: spaceId }),
    listMachineKeys: async () => registrations.map(({ keyId }) => ({ keyId, revokedAt: null })),
    registerMachineKey: async (
      keyId: string,
      _publicKey: string,
      _label: string,
      _destination: unknown,
      signingPublicKey?: string,
    ) => {
      registrations.push({ keyId, signingPublicKey })
      return {}
    },
  } as unknown as ConfigClient

  writeMachineKey(await generateMachineKeyPair(), env)
  const keyId = await machineInit(spaceId, 'fixture', client, env)
  const signingPair = readMachineSigningKey(env)

  expect(signingPair).not.toBeNull()
  expect(registrations).toEqual([
    { keyId, signingPublicKey: Buffer.from(signingPair!.publicKey).toString('base64url') },
  ])
  expect(readMachineKey(env)).not.toBeNull()
  expect(Object.keys(await readTrustList(env))).toEqual([keyId])
  expect(readHostedConfigIdentity(env)).toEqual({ spaceId, userId })
})

test('machine init converges with an existing key, pin, space, and registration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-init-convergence-'))
  roots.push(root)
  const env = { BOTTEGA_CONFIG_HOME: root, BOTTEGA_KEYSTORE: 'file' }
  const registrations: Array<{ keyId: string; signingPublicKey?: string }> = []
  const spaceId = '01990000-0000-7000-8000-000000000001'
  const userId = '01990000-0000-7000-8000-000000000002'
  let identity = { user: { id: userId }, activeSpaceId: spaceId }
  const client = {
    whoami: async () => identity,
    listMachineKeys: async () => registrations.map(({ keyId }) => ({ keyId, revokedAt: null })),
    registerMachineKey: async (
      keyId: string,
      _publicKey: string,
      _label: string,
      _destination: unknown,
      signingPublicKey?: string,
    ) => {
      registrations.push({ keyId, signingPublicKey })
      return {}
    },
  } as unknown as ConfigClient

  const first = await machineInit(spaceId, 'fixture', client, env)
  const privateKey = readMachineKey(env)?.privateKey
  const signingPair = readMachineSigningKey(env)
  const signingPublicKey = Buffer.from(signingPair!.publicKey).toString('base64url')
  await expect(machineInit(spaceId, 'fixture', client, env)).resolves.toBe(first)
  expect(readMachineKey(env)?.privateKey).toEqual(privateKey)
  expect(readMachineSigningKey(env)).toEqual(signingPair)
  expect(Object.keys(await readTrustList(env))).toEqual([first])
  expect(readHostedConfigIdentity(env)).toEqual({ spaceId, userId })
  expect(registrations).toEqual([
    { keyId: first, signingPublicKey },
    { keyId: first, signingPublicKey },
  ])

  identity = { ...identity, activeSpaceId: '01990000-0000-7000-8000-000000000003' }
  await expect(machineInit(identity.activeSpaceId, 'fixture', client, env)).rejects.toThrow(
    'switch back',
  )
  expect(readHostedConfigIdentity(env)).toEqual({ spaceId, userId })
  expect(registrations).toHaveLength(2)

  identity = {
    user: { id: '01990000-0000-7000-8000-000000000004' },
    activeSpaceId: spaceId,
  }
  await expect(machineInit(spaceId, 'fixture', client, env)).rejects.toThrow('sign back in')
  expect(readHostedConfigIdentity(env)).toEqual({ spaceId, userId })
  expect(registrations).toHaveLength(2)
})
