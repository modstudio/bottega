import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import { writeHostedConfigIdentity } from '../../../shared/hosted-config-space.ts'
import { machineKeyId } from '../../../shared/machine-key-id.ts'
import { writeMachineKey } from '../../../shared/machine-key-store.ts'
import { writeMachineSigningKey } from '../../../shared/machine-signing-key.ts'
import {
  generateDataKey,
  generateMachineKeyPair,
  sealValue,
  wrapDataKey,
} from '../../../shared/secret-envelope.ts'
import { pinTrustedMachine } from '../../../shared/trust-list.ts'
import {
  machineRevokeTrustLogFixture,
  trackedTrustLogClient,
  trustLogFixtureSigningKey,
} from './config-service-trust-log.fixture.ts'

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: one fixture keeps the mutable key, secret, and trust-log state coherent
export async function rotationFixture(
  roots: string[],
  revokedAt: string | null,
  resumeRow = false,
  sameKeyBindings = false,
  userScope = false,
  withTrustLog = false,
  withoutSelfWrap = false,
) {
  const root = mkdtempSync(join(tmpdir(), 'config-rotation-'))
  roots.push(root)
  process.env.BOTTEGA_CONFIG_HOME = root
  process.env.BOTTEGA_KEYSTORE = 'file'
  const pair = await generateMachineKeyPair()
  writeMachineKey(pair)
  const keyId = await machineKeyId(pair.publicKey)
  await pinTrustedMachine(keyId, pair.publicKey, 'current')
  const other = await generateMachineKeyPair()
  const otherKeyId = await machineKeyId(other.publicKey)
  await pinTrustedMachine(otherKeyId, other.publicKey, 'other')
  const recipient = await generateMachineKeyPair()
  const recipientKeyId = await machineKeyId(recipient.publicKey)
  const spaceId = '01990000-0000-7000-8000-000000000001'
  const userId = '01990000-0000-7000-8000-000000000002'
  writeHostedConfigIdentity({ spaceId, userId })
  const signing = trustLogFixtureSigningKey(31)
  const trustLog = machineRevokeTrustLogFixture(
    withTrustLog,
    spaceId,
    [keyId, pair.publicKey, signing.publicKey, 'current'],
    [otherKeyId, other.publicKey, trustLogFixtureSigningKey(32).publicKey, 'other'],
    signing.privateKey,
  )
  if (withTrustLog) writeMachineSigningKey(signing, process.env)
  const oldId = '01990000-0000-7000-8000-000000000003'
  const oldDek = generateDataKey()
  const wrapped = await wrapDataKey({
    dek: oldDek,
    wrapContext: { spaceId, dekId: oldId, dekVersion: 1 },
    senderPrivateKey: withoutSelfWrap ? other.privateKey : pair.privateKey,
    senderPublicKey: withoutSelfWrap ? other.publicKey : pair.publicKey,
    recipientPublicKey: pair.publicKey,
  })
  const encode = (value: Uint8Array) => Buffer.from(value).toString('base64url')
  const oldKey = {
    id: oldId,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    retiredAt: null,
    wraps: [
      {
        recipientKeyId: keyId,
        senderKeyId: withoutSelfWrap ? otherKeyId : keyId,
        enc: encode(wrapped.enc),
        ciphertext: encode(wrapped.ciphertext),
      },
    ],
  }
  const currentId = '01990000-0000-7000-8000-000000000004'
  const currentDek = resumeRow ? generateDataKey() : oldDek
  const currentWrapped = resumeRow
    ? await wrapDataKey({
        dek: currentDek,
        wrapContext: { spaceId, dekId: currentId, dekVersion: 2 },
        senderPrivateKey: pair.privateKey,
        senderPublicKey: pair.publicKey,
        recipientPublicKey: pair.publicKey,
      })
    : wrapped
  let current = resumeRow
    ? {
        id: currentId,
        version: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        retiredAt: null,
        wraps: [
          {
            recipientKeyId: keyId,
            senderKeyId: keyId,
            enc: encode(currentWrapped.enc),
            ciphertext: encode(currentWrapped.ciphertext),
          },
        ],
      }
    : oldKey
  const oldEnvelope = sealValue({
    dek: oldDek,
    plaintext: new TextEncoder().encode('resume-me'),
    valueContext: {
      spaceId,
      userId: userScope ? userId : null,
      keyName: 'TOKEN',
      environment: 'default',
      dekId: oldId,
      rowVersion: 1,
    },
  })
  const baseSecret = {
    key: 'TOKEN',
    environment: 'default',
    scope: userScope ? ('user' as const) : ('space' as const),
    projectId: null as string | null,
    dekId: oldId,
    rowVersion: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    envelope: encode(oldEnvelope),
  }
  const projectId = '01990000-0000-7000-8000-000000000005'
  let secrets = sameKeyBindings ? [baseSecret, { ...baseSecret, projectId }] : [baseSecret]
  const putSecretDestinations: Array<{ destinationSpaceId: string; projectId?: string | null }> = []
  const machines = [
    { keyId, publicKey: encode(pair.publicKey), label: 'current', createdAt: '', revokedAt: null },
    {
      keyId: otherKeyId,
      publicKey: encode(other.publicKey),
      label: 'other',
      createdAt: '',
      revokedAt,
    },
    {
      keyId: recipientKeyId,
      publicKey: encode(recipient.publicKey),
      label: 'recipient',
      createdAt: '',
      revokedAt: null,
    },
  ]
  const [created, retired] = [[], []] as [string[], string[]]
  const addWrapDestinations: string[] = []
  const revokeDestinations: string[] = []
  const trustLogClient = trackedTrustLogClient(trustLog)
  let oldRetiredAt: string | null = null
  const client = {
    whoami: async () => ({ user: { id: userId }, activeSpaceId: spaceId }),
    currentDataKey: async () => current,
    listMachineKeys: async () => machines,
    createDataKey: async (input: {
      dekId: string
      version: number
      wraps: typeof current.wraps
    }) => {
      created.push(input.dekId)
      current = {
        id: input.dekId,
        version: input.version,
        createdAt: '2027-01-01T00:00:00.000Z',
        retiredAt: null,
        wraps: input.wraps,
      }
    },
    getDataKey: async (id: string) => (id === oldId ? oldKey : current),
    listSecrets: async () => (resumeRow ? secrets : []),
    listDataKeys: async () => [{ ...oldKey, retiredAt: oldRetiredAt }, current],
    retireDataKey: async (id: string) => {
      retired.push(id)
      if (id === oldId) oldRetiredAt = '2027-01-01T00:00:00.000Z'
    },
    getSecret: async (
      _key: string,
      _scope: string,
      _environment: string,
      destination: { projectId?: string | null } = {},
    ) => {
      if (!resumeRow) throw new ConfigClientError('response', '/v1/config/secrets', 404)
      return secrets.find((row) => row.projectId === (destination.projectId ?? null))!
    },
    putSecret: async (
      _key: string,
      input: { dekId: string; envelope: string; projectId?: string | null },
      destination: { destinationSpaceId: string; projectId?: string | null },
    ) => {
      putSecretDestinations.push(destination)
      const index = secrets.findIndex((row) => row.projectId === (input.projectId ?? null))
      const secret = secrets[index]!
      const updated = {
        ...secret,
        dekId: input.dekId,
        rowVersion: secret.rowVersion + 1,
        envelope: input.envelope,
      }
      secrets = secrets.with(index, updated)
      return updated
    },
    addWraps: async (
      dekId: string,
      wraps: typeof current.wraps,
      destination: { destinationSpaceId?: string },
    ) => {
      addWrapDestinations.push(destination.destinationSpaceId ?? '')
      if (dekId !== current.id) throw new Error('unknown data key')
      for (const wrap of wraps) {
        if (
          current.wraps.some(
            (item) =>
              item.recipientKeyId === wrap.recipientKeyId && item.senderKeyId === wrap.senderKeyId,
          )
        )
          throw new Error('duplicate secret_dek_wrap tuple')
      }
      current.wraps.push(...wraps)
    },
    revokeMachineKey: async (id: string, destination: { destinationSpaceId?: string }) => {
      revokeDestinations.push(destination.destinationSpaceId ?? '')
      trustLogClient.recordCallOrder.push('revokeMachineKey')
      const found = machines.find((item) => item.keyId === id)!
      found.revokedAt = '2026-06-01T00:00:00.000Z'
    },
    ...trustLogClient.methods,
  } as unknown as ConfigClient
  return {
    client,
    spaceId,
    created,
    retired,
    otherKeyId,
    recipientKeyId,
    recipientPublicKey: encode(recipient.publicKey),
    current: () => current,
    secrets: () => secrets,
    putSecretDestinations,
    addWrapDestinations,
    revokeDestinations,
    trustLog,
    appendedTrustLogEntry: trustLogClient.appendedTrustLogEntry,
    recordCallOrder: trustLogClient.recordCallOrder,
  }
}
