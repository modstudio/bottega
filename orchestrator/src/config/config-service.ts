// concern: config-command-service
/** Composes local bootstrap custody, hosted config operations, and pure rotation policy. */
import { hostname } from 'node:os'
import {
  type ConfigClient,
  ConfigClientError,
  type ConfigScope,
  type ConfigSecret,
  configClient,
  type DataKey,
} from '../../../shared/config-client.ts'
import {
  machineKeyInfo,
  readMachineKey,
  writeMachineKey,
} from '../../../shared/machine-key-store.ts'
import {
  generateDataKey,
  generateMachineKeyPair,
  machineKeyId,
  openValue,
  sealValue,
  unwrapDataKey,
  wrapDataKey,
} from '../../../shared/secret-envelope.ts'
import {
  pinTrustedMachine,
  readTrustList,
  type TrustList,
  unpinTrustedMachine,
} from '../../../shared/trust-list.ts'

const ENVIRONMENT = 'default'
const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'))
const encoded = (value: Uint8Array) => Buffer.from(value).toString('base64url')

export type RotationPlan = { reseal: ConfigSecret[]; retireDekIds: string[] }

export function planRotation(rows: ConfigSecret[], currentDekId: string): RotationPlan {
  const reseal = rows.filter((row) => row.dekId !== currentDekId)
  return { reseal, retireDekIds: [...new Set(reseal.map((row) => row.dekId))].sort() }
}

async function localMachine() {
  const pair = readMachineKey()
  if (!pair) throw new Error('machine key is not initialized; run `orch config machine init`')
  return machineKeyInfo(pair)
}

async function identity(client: ConfigClient) {
  const current = await client.whoami()
  if (!current.activeSpaceId) throw new Error('record session has no active space')
  return { spaceId: current.activeSpaceId, userId: current.user.id }
}

async function unwrap(
  client: ConfigClient,
  key: DataKey,
  machine?: Awaited<ReturnType<typeof localMachine>>,
  trust?: TrustList,
) {
  const local = machine ?? (await localMachine())
  const trusted = trust ?? (await readTrustList())
  const wrap = key.wraps.find((item) => trusted[item.senderKeyId]) ?? key.wraps[0]
  if (!wrap) throw new Error(`data key ${key.id} has no wrap addressed to this machine`)
  const sender = trusted[wrap.senderKeyId]
  if (!sender) throw new Error(`data key ${key.id} sender ${wrap.senderKeyId} is not trusted`)
  const who = await identity(client)
  return unwrapDataKey({
    enc: bytes(wrap.enc),
    ciphertext: bytes(wrap.ciphertext),
    wrapContext: { spaceId: who.spaceId, dekId: key.id, dekVersion: key.version },
    recipientPrivateKey: local.privateKey,
    senderPublicKey: bytes(sender.public_key),
    trustedSenderKeyIds: new Set(Object.keys(trusted)),
  })
}

async function wrapsFor(
  dek: Uint8Array,
  dekId: string,
  version: number,
  trust: TrustList,
  client: ConfigClient,
) {
  const machine = await localMachine()
  const who = await identity(client)
  return Promise.all(
    Object.entries(trust).map(async ([recipientKeyId, recipient]) => {
      const wrapped = await wrapDataKey({
        dek,
        wrapContext: { spaceId: who.spaceId, dekId, dekVersion: version },
        senderPrivateKey: machine.privateKey,
        senderPublicKey: machine.publicKey,
        recipientPublicKey: bytes(recipient.public_key),
      })
      return {
        recipientKeyId,
        senderKeyId: machine.keyId,
        enc: encoded(wrapped.enc),
        ciphertext: encoded(wrapped.ciphertext),
      }
    }),
  )
}

async function currentOrCreate(client: ConfigClient) {
  const machine = await localMachine()
  try {
    const key = await client.currentDataKey(machine.keyId)
    return { key, dek: await unwrap(client, key, machine) }
  } catch (error) {
    if (!(error instanceof ConfigClientError) || error.status !== 404) throw error
    const trust = await readTrustList()
    const dek = generateDataKey()
    const dekId = crypto.randomUUID()
    const version = 1
    await client.createDataKey({
      dekId,
      version,
      wraps: await wrapsFor(dek, dekId, version, trust, client),
    })
    return { key: await client.getDataKey(dekId, machine.keyId), dek }
  }
}

export async function machineInit(label = hostname(), client = configClient()): Promise<string> {
  if (readMachineKey()) throw new Error('machine key already exists; refusing to overwrite it')
  const pair = await generateMachineKeyPair()
  const keyId = await machineKeyId(pair.publicKey)
  writeMachineKey(pair)
  await pinTrustedMachine(keyId, pair.publicKey, label)
  await client.registerMachineKey(keyId, encoded(pair.publicKey), label)
  return keyId
}

export async function machineShow() {
  const machine = await localMachine()
  return { keyId: machine.keyId, publicKey: encoded(machine.publicKey) }
}

export async function machineTrust(
  keyId: string,
  publicKey: string,
  label: string,
  client = configClient(),
) {
  const publicBytes = bytes(publicKey)
  if ((await machineKeyId(publicBytes)) !== keyId)
    throw new Error('machine key id does not match public key')
  await pinTrustedMachine(keyId, publicBytes, label)
  const machine = await localMachine()
  try {
    const current = await client.currentDataKey(machine.keyId)
    const dek = await unwrap(client, current, machine)
    const who = await identity(client)
    const wrapped = await wrapDataKey({
      dek,
      wrapContext: { spaceId: who.spaceId, dekId: current.id, dekVersion: current.version },
      senderPrivateKey: machine.privateKey,
      senderPublicKey: machine.publicKey,
      recipientPublicKey: publicBytes,
    })
    await client.addWraps(current.id, [
      {
        recipientKeyId: keyId,
        senderKeyId: machine.keyId,
        enc: encoded(wrapped.enc),
        ciphertext: encoded(wrapped.ciphertext),
      },
    ])
  } catch (error) {
    if (!(error instanceof ConfigClientError) || error.status !== 404) throw error
  }
}

async function rowPlaintext(
  client: ConfigClient,
  row: ConfigSecret,
  machine?: Awaited<ReturnType<typeof localMachine>>,
): Promise<Uint8Array> {
  const local = machine ?? (await localMachine())
  const key = await client.getDataKey(row.dekId, local.keyId)
  const dek = await unwrap(client, key, local)
  const who = await identity(client)
  const full = await client.getSecret(row.key, row.scope, row.environment)
  return openValue({
    envelope: bytes(full.envelope),
    dek,
    valueContext: {
      spaceId: who.spaceId,
      userId: row.scope === 'user' ? who.userId : null,
      keyName: row.key,
      environment: row.environment,
      dekId: row.dekId,
      rowVersion: row.rowVersion,
    },
  })
}

export async function machineRevoke(keyId: string, client = configClient()): Promise<string[]> {
  const machine = await localMachine()
  if (keyId === machine.keyId)
    throw new Error('cannot revoke this machine own key; revoke it from another trusted machine')
  let remote = await client.listMachineKeys()
  let revokedAt = remote.find((item) => item.keyId === keyId)?.revokedAt
  if (!revokedAt) {
    const trustBefore = await readTrustList()
    if (!trustBefore[keyId]) throw new Error(`machine key ${keyId} is not trusted locally`)
    const currentBefore = await client.currentDataKey(machine.keyId)
    const oldDek = await unwrap(client, currentBefore, machine, trustBefore)
    if (!currentBefore.wraps.some((wrap) => wrap.senderKeyId === machine.keyId)) {
      const self = trustBefore[machine.keyId]
      if (!self) throw new Error('this machine is absent from the trust list')
      const who = await identity(client)
      const wrapped = await wrapDataKey({
        dek: oldDek,
        wrapContext: {
          spaceId: who.spaceId,
          dekId: currentBefore.id,
          dekVersion: currentBefore.version,
        },
        senderPrivateKey: machine.privateKey,
        senderPublicKey: machine.publicKey,
        recipientPublicKey: machine.publicKey,
      })
      await client.addWraps(currentBefore.id, [
        {
          recipientKeyId: machine.keyId,
          senderKeyId: machine.keyId,
          enc: encoded(wrapped.enc),
          ciphertext: encoded(wrapped.ciphertext),
        },
      ])
    }
    await unpinTrustedMachine(keyId)
    await client.revokeMachineKey(keyId)
    remote = await client.listMachineKeys()
    revokedAt = remote.find((item) => item.keyId === keyId)?.revokedAt
  }
  const trust = await readTrustList()
  let current = await client.currentDataKey(machine.keyId)
  const rows = await client.listSecrets(ENVIRONMENT)
  const alreadyRotating = Boolean(revokedAt && new Date(current.createdAt) >= new Date(revokedAt))
  let dek: Uint8Array
  if (alreadyRotating) dek = await unwrap(client, current, machine, trust)
  else {
    dek = generateDataKey()
    const dekId = crypto.randomUUID()
    const version = current.version + 1
    await client.createDataKey({
      dekId,
      version,
      wraps: await wrapsFor(dek, dekId, version, trust, client),
    })
    current = await client.getDataKey(dekId, machine.keyId)
  }
  const plan = planRotation(rows, current.id)
  const completed: string[] = []
  try {
    const who = await identity(client)
    for (const row of plan.reseal) {
      const plaintext = await rowPlaintext(client, row, machine)
      const envelope = sealValue({
        dek,
        plaintext,
        valueContext: {
          spaceId: who.spaceId,
          userId: row.scope === 'user' ? who.userId : null,
          keyName: row.key,
          environment: row.environment,
          dekId: current.id,
          rowVersion: row.rowVersion + 1,
        },
      })
      await client.putSecret(row.key, {
        scope: row.scope,
        environment: row.environment,
        dekId: current.id,
        envelope: encoded(envelope),
        expectedRowVersion: row.rowVersion,
      })
      completed.push(`${row.scope}:${row.environment}:${row.key}`)
    }
    for (const oldId of plan.retireDekIds) await client.retireDataKey(oldId)
    return completed
  } catch (error) {
    throw new Error(
      `rotation stopped after re-sealing rows [${completed.join(', ')}]: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function setSecret(
  key: string,
  value: string,
  scope: ConfigScope,
  client = configClient(),
) {
  const { key: dataKey, dek } = await currentOrCreate(client)
  let existing: ConfigSecret | null = null
  try {
    existing = await client.getSecret(key, scope, ENVIRONMENT)
  } catch (error) {
    if (!(error instanceof ConfigClientError) || error.status !== 404) throw error
  }
  const who = await identity(client)
  const rowVersion = (existing?.rowVersion ?? 0) + 1
  const envelope = sealValue({
    dek,
    plaintext: new TextEncoder().encode(value),
    valueContext: {
      spaceId: who.spaceId,
      userId: scope === 'user' ? who.userId : null,
      keyName: key,
      environment: ENVIRONMENT,
      dekId: dataKey.id,
      rowVersion,
    },
  })
  return client.putSecret(key, {
    scope,
    environment: ENVIRONMENT,
    dekId: dataKey.id,
    envelope: encoded(envelope),
    expectedRowVersion: existing?.rowVersion ?? null,
  })
}

export async function deleteSecret(key: string, scope: ConfigScope, client = configClient()) {
  const row = await client.getSecret(key, scope, ENVIRONMENT)
  return client.deleteSecret(key, {
    scope,
    environment: ENVIRONMENT,
    expectedRowVersion: row.rowVersion,
  })
}
