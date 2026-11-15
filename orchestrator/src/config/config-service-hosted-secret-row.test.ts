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
const otherSpaceId = '01990000-0000-7000-8000-000000000204'
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
  writeHostedConfigIdentity({ spaceId: otherSpaceId, userId })

  const recipient = await generateMachineKeyPair()
  const recipientKeyId = await machineKeyId(recipient.publicKey)
  const sender = await generateMachineKeyPair()
  const senderKeyId = await machineKeyId(sender.publicKey)
  const loggedOther = await generateMachineKeyPair()
  const loggedOtherKeyId = await machineKeyId(loggedOther.publicKey)
  const logForSpace = (logSpaceId: string, includesSender: boolean, signingSeed: number) => {
    const first = includesSender ? sender : loggedOther
    const firstKeyId = includesSender ? senderKeyId : loggedOtherKeyId
    const added = includesSender ? loggedOther : recipient
    const addedKeyId = includesSender ? loggedOtherKeyId : recipientKeyId
    const firstSigning = trustLogFixtureSigningKey(signingSeed)
    return machineRevokeTrustLogFixture(
      true,
      logSpaceId,
      [firstKeyId, first.publicKey, firstSigning.publicKey, 'first'],
      [addedKeyId, added.publicKey, trustLogFixtureSigningKey(signingSeed + 1).publicKey, 'added'],
      firstSigning.privateKey,
    )
  }
  const destinationLog = logForSpace(spaceId, logListsSender, logListsSender ? 71 : 73)
  const otherLog = logForSpace(otherSpaceId, !logListsSender, logListsSender ? 75 : 77)
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
    whoami: async () => ({
      user: { id: userId },
      activeSpaceId: otherSpaceId,
      memberships: [
        { space_id: otherSpaceId, slug: 'other', permission: 'write' },
        { space_id: spaceId, slug: 'destination', permission: 'write' },
      ],
    }),
    listMachineKeys: async ({ destinationSpaceId }: { destinationSpaceId?: string }) =>
      destinationSpaceId === spaceId ? [{ keyId: recipientKeyId, userId, revokedAt: null }] : [],
    readTrustLog: async ({ destinationSpaceId }: { destinationSpaceId?: string }) =>
      destinationSpaceId === spaceId ? destinationLog : otherLog,
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
    openHostedSecretRow(
      fixture.client,
      fixture.row,
      { destinationSpaceId: spaceId },
      fixture.recipient,
    ),
  ).resolves.toEqual(new TextEncoder().encode('opened from verified log'))
})

test('hosted secret reader refuses a sender listed only by the other space log', async () => {
  const fixture = await readerFixture(false)

  await expect(
    openHostedSecretRow(
      fixture.client,
      fixture.row,
      { destinationSpaceId: spaceId },
      fixture.recipient,
    ),
  ).rejects.toThrow('hosted secret data-key sender is not trusted')
})
