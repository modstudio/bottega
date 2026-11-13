import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConfigClient, ConfigSecret } from '../../../shared/config-client.ts'
import { writeHostedConfigIdentity } from '../../../shared/hosted-config-space.ts'
import { openHostedSecretRow } from '../../../shared/hosted-secret-row.ts'
import { machineKeyId } from '../../../shared/machine-key-id.ts'
import {
  generateDataKey,
  generateMachineKeyPair,
  sealValue,
  wrapDataKey,
} from '../../../shared/secret-envelope.ts'
import { pinTrustedMachine } from '../../../shared/trust-list.ts'
import {
  machineRevokeTrustLogFixture,
  trustLogFixtureSigningKey,
} from './config-service-trust-log.fixture.ts'

const roots: string[] = []
const spaceId = '01990000-0000-7000-8000-000000000201'
const userId = '01990000-0000-7000-8000-000000000202'
const dekId = '01990000-0000-7000-8000-000000000203'
let previousConfigHome: string | undefined, previousKeystore: string | undefined

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (previousConfigHome === undefined) delete process.env.BOTTEGA_CONFIG_HOME
  else process.env.BOTTEGA_CONFIG_HOME = previousConfigHome
  if (previousKeystore === undefined) delete process.env.BOTTEGA_KEYSTORE
  else process.env.BOTTEGA_KEYSTORE = previousKeystore
})

async function readerFixture(logListsSender: boolean) {
  previousConfigHome = process.env.BOTTEGA_CONFIG_HOME
  previousKeystore = process.env.BOTTEGA_KEYSTORE
  const root = mkdtempSync(join(tmpdir(), 'hosted-secret-row-trust-log-'))
  roots.push(root)
  process.env.BOTTEGA_CONFIG_HOME = root
  process.env.BOTTEGA_KEYSTORE = 'file'
  writeHostedConfigIdentity({ spaceId, userId })

  const recipient = await generateMachineKeyPair()
  const recipientKeyId = await machineKeyId(recipient.publicKey)
  const sender = await generateMachineKeyPair()
  const senderKeyId = await machineKeyId(sender.publicKey)
  const loggedOther = await generateMachineKeyPair()
  const loggedOtherKeyId = await machineKeyId(loggedOther.publicKey)
  const first = logListsSender ? sender : loggedOther
  const firstKeyId = logListsSender ? senderKeyId : loggedOtherKeyId
  const firstSigning = trustLogFixtureSigningKey(logListsSender ? 71 : 72)
  const added = logListsSender ? loggedOther : recipient
  const addedKeyId = logListsSender ? loggedOtherKeyId : recipientKeyId
  const log = machineRevokeTrustLogFixture(
    true,
    spaceId,
    [firstKeyId, first.publicKey, firstSigning.publicKey, 'first'],
    [
      addedKeyId,
      added.publicKey,
      trustLogFixtureSigningKey(logListsSender ? 73 : 74).publicKey,
      'added',
    ],
    firstSigning.privateKey,
  )
  if (!logListsSender) await pinTrustedMachine(senderKeyId, sender.publicKey, 'pinned sender')

  const dek = generateDataKey()
  const wrapped = await wrapDataKey({
    dek,
    wrapContext: { spaceId, dekId, dekVersion: 1 },
    senderPrivateKey: sender.privateKey,
    senderPublicKey: sender.publicKey,
    recipientPublicKey: recipient.publicKey,
  })
  const row: ConfigSecret & { envelope: string } = {
    key: 'TOKEN',
    environment: 'default',
    scope: 'user',
    dekId,
    rowVersion: 1,
    updatedAt: '2026-11-13T00:00:00.000Z',
    envelope: Buffer.from(
      sealValue({
        dek,
        plaintext: new TextEncoder().encode('opened from verified log'),
        valueContext: {
          spaceId,
          userId,
          keyName: 'TOKEN',
          environment: 'default',
          dekId,
          rowVersion: 1,
        },
      }),
    ).toString('base64url'),
  }
  const client = {
    whoami: async () => ({ user: { id: userId }, activeSpaceId: spaceId }),
    readTrustLog: async () => log,
    getSecret: async () => row,
    getDataKey: async () => ({
      id: dekId,
      version: 1,
      createdAt: '2026-11-13T00:00:00.000Z',
      retiredAt: null,
      wraps: [
        {
          recipientKeyId,
          senderKeyId,
          enc: Buffer.from(wrapped.enc).toString('base64url'),
          ciphertext: Buffer.from(wrapped.ciphertext).toString('base64url'),
        },
      ],
    }),
  } as unknown as ConfigClient
  return { client, row, recipient: { ...recipient, keyId: recipientKeyId } }
}

test('hosted secret reader accepts a verified-log sender that was never pinned', async () => {
  const fixture = await readerFixture(true)

  await expect(
    openHostedSecretRow(fixture.client, fixture.row, {}, fixture.recipient),
  ).resolves.toEqual(new TextEncoder().encode('opened from verified log'))
})

test('hosted secret reader refuses a pinned sender omitted by the verified log', async () => {
  const fixture = await readerFixture(false)

  await expect(
    openHostedSecretRow(fixture.client, fixture.row, {}, fixture.recipient),
  ).rejects.toThrow('hosted secret data-key sender is not trusted')
})
