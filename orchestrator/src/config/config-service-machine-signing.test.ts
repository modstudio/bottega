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
