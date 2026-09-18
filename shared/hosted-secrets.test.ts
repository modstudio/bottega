import { expect, test } from 'bun:test'
import type { ConfigClient } from './config-client.ts'
import { HostedSecretError, readHostedSecrets } from './hosted-secrets.ts'
import {
  generateDataKey,
  generateMachineKeyPair,
  machineKeyId,
  sealValue,
  wrapDataKey,
} from './secret-envelope.ts'

const spaceId = '01990000-0000-7000-8000-000000000001'
const userId = '01990000-0000-7000-8000-000000000002'
const dekId = '01990000-0000-7000-8000-000000000003'

async function fixture() {
  const machine = await generateMachineKeyPair()
  const keyId = await machineKeyId(machine.publicKey)
  const dek = generateDataKey()
  const wrapped = await wrapDataKey({
    dek,
    wrapContext: { spaceId, dekId, dekVersion: 1 },
    senderPrivateKey: machine.privateKey,
    senderPublicKey: machine.publicKey,
    recipientPublicKey: machine.publicKey,
  })
  const envelope = sealValue({
    dek,
    plaintext: new TextEncoder().encode('hosted-value'),
    valueContext: {
      spaceId,
      userId,
      keyName: 'TOKEN',
      environment: 'default',
      dekId,
      rowVersion: 1,
    },
  })
  const client = {
    getSecret: async () => ({
      key: 'TOKEN',
      environment: 'default',
      scope: 'user' as const,
      dekId,
      rowVersion: 1,
      updatedAt: '2026-09-18T12:00:00.000Z',
      envelope: Buffer.from(envelope).toString('base64url'),
    }),
    getDataKey: async () => ({
      id: dekId,
      version: 1,
      createdAt: '2026-09-18T12:00:00.000Z',
      retiredAt: null,
      wraps: [
        {
          recipientKeyId: keyId,
          senderKeyId: keyId,
          enc: Buffer.from(wrapped.enc).toString('base64url'),
          ciphertext: Buffer.from(wrapped.ciphertext).toString('base64url'),
        },
      ],
    }),
    whoami: async () => ({ user: { id: userId }, activeSpaceId: spaceId }),
  } as unknown as ConfigClient
  return {
    machine: { ...machine, keyId },
    dek,
    client,
    trust: {
      [keyId]: {
        public_key: Buffer.from(machine.publicKey).toString('base64url'),
        label: 'self',
        pinned_at: '2026-09-18T12:00:00.000Z',
      },
    },
  }
}

test('hosted resolver fetches, unwraps and opens a sealed value', async () => {
  const deps = await fixture()
  await expect(readHostedSecrets(['TOKEN'], deps)).resolves.toEqual({ TOKEN: 'hosted-value' })
})

test('untrusted sender refusal carries the requested secret name', async () => {
  const deps = await fixture()
  let error: unknown
  try {
    await readHostedSecrets(['TOKEN'], { ...deps, trust: {} })
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(HostedSecretError)
  expect(error).toMatchObject({ secretName: 'TOKEN', reason: 'untrusted-sender' })
})

test('refuses a valid row returned for a different requested secret', async () => {
  const deps = await fixture()
  const original = deps.client.getSecret.bind(deps.client)
  const otherEnvelope = sealValue({
    dek: deps.dek,
    plaintext: new TextEncoder().encode('other-hosted-value'),
    valueContext: {
      spaceId,
      userId,
      keyName: 'OTHER_TOKEN',
      environment: 'default',
      dekId,
      rowVersion: 1,
    },
  })
  deps.client.getSecret = async (...args) => ({
    ...(await original(...args)),
    key: 'OTHER_TOKEN',
    envelope: Buffer.from(otherEnvelope).toString('base64url'),
  })

  await expect(readHostedSecrets(['TOKEN'], deps)).rejects.toMatchObject({
    secretName: 'TOKEN',
    reason: 'authentication-failed',
  })
})
