import { expect, test } from 'bun:test'
import { type ConfigClient, ConfigClientError } from './config-client.ts'
import { HostedSecretError, readHostedSecrets } from './hosted-secrets.ts'
import { machineKeyId } from './machine-key-id.ts'
import {
  generateDataKey,
  generateMachineKeyPair,
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
  const rowFor = (key: string, scope: 'user' | 'space', plaintext: string) => ({
    key,
    environment: 'default',
    scope,
    dekId,
    rowVersion: 1,
    updatedAt: '2026-09-18T12:00:00.000Z',
    envelope: Buffer.from(
      sealValue({
        dek,
        plaintext: new TextEncoder().encode(plaintext),
        valueContext: {
          spaceId,
          userId: scope === 'user' ? userId : null,
          keyName: key,
          environment: 'default',
          dekId,
          rowVersion: 1,
        },
      }),
    ).toString('base64url'),
  })
  const rows = new Map([['user:TOKEN', rowFor('TOKEN', 'user', 'hosted-value')]])
  const client = {
    getSecret: async (name: string, scope: string) => {
      const row = rows.get(`${scope}:${name}`)
      if (!row) throw new ConfigClientError('response', `/v1/config/secrets/${name}`, 404)
      return row
    },
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
    pinnedIdentity: { spaceId, userId },
    dek,
    client,
    rows,
    rowFor,
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
  await expect(readHostedSecrets(['TOKEN'], deps)).resolves.toEqual({
    values: { TOKEN: 'hosted-value' },
    sealedEmpty: [],
  })
})

test('a sealed copy that is blank resolves as absent and reports itself sealed empty', async () => {
  const deps = await fixture()
  deps.rows.set('user:TOKEN', deps.rowFor('TOKEN', 'user', '   '))
  await expect(readHostedSecrets(['TOKEN'], deps)).resolves.toEqual({
    values: { TOKEN: undefined },
    sealedEmpty: ['TOKEN'],
  })
})

test('a blank user-scope copy opens the space-scope copy exactly as an absent row would', async () => {
  const deps = await fixture()
  deps.rows.delete('user:TOKEN')
  deps.rows.set('space:TOKEN', deps.rowFor('TOKEN', 'space', 'space-value'))
  await expect(readHostedSecrets(['TOKEN'], deps)).resolves.toEqual({
    values: { TOKEN: 'space-value' },
    sealedEmpty: [],
  })
  deps.rows.set('user:TOKEN', deps.rowFor('TOKEN', 'user', ''))
  await expect(readHostedSecrets(['TOKEN'], deps)).resolves.toEqual({
    values: { TOKEN: 'space-value' },
    sealedEmpty: [],
  })
})

test('a name no scope holds is absent without being reported sealed empty', async () => {
  const deps = await fixture()
  await expect(readHostedSecrets(['ABSENT'], deps)).resolves.toEqual({
    values: { ABSENT: undefined },
    sealedEmpty: [],
  })
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

test('refuses when the signed-in active space differs from the initialized space', async () => {
  const deps = await fixture()
  deps.client.whoami = async () => ({
    user: { id: userId },
    activeSpaceId: '01990000-0000-7000-8000-000000000099',
  })
  await expect(readHostedSecrets(['TOKEN'], deps)).rejects.toMatchObject({
    secretName: 'TOKEN',
    reason: 'hosted-failure',
  })
  await expect(readHostedSecrets(['TOKEN'], deps)).rejects.toThrow('switch back')
})

test('refuses when the signed-in user differs from the initialized user', async () => {
  const deps = await fixture()
  deps.client.whoami = async () => ({
    user: { id: '01990000-0000-7000-8000-000000000099' },
    activeSpaceId: spaceId,
  })
  await expect(readHostedSecrets(['TOKEN'], deps)).rejects.toMatchObject({
    secretName: 'TOKEN',
    reason: 'hosted-failure',
  })
  await expect(readHostedSecrets(['TOKEN'], deps)).rejects.toThrow('sign back in')
})
