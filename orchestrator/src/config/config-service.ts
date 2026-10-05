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
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import {
  readHostedConfigIdentity,
  writeHostedConfigIdentity,
} from '../../../shared/hosted-config-space.ts'
import {
  HOSTED_CONFIG_ENVIRONMENT,
  hostedIdentity,
  openHostedSecret,
} from '../../../shared/hosted-secret-opening.ts'
import {
  deleteMachineAutonomy,
  isShipToConfigKey,
  listMachineAutonomy,
  SHIP_TO_CONFIG_KEY,
  STORED_SHIP_TO_CONFIG_ALIAS,
  setMachineAutonomy,
  storedShipToLevel,
} from '../../../shared/machine-config.ts'
import { machineKeyId } from '../../../shared/machine-key-id.ts'
import {
  machineKeyInfo,
  readMachineKey,
  writeMachineKey,
} from '../../../shared/machine-key-store.ts'
import {
  pinnedSpaceMismatchRemedy,
  pinnedUserMismatchRemedy,
  RECORD_ACTIVE_SPACE_REMEDY,
} from '../../../shared/record-remedies.ts'
import {
  generateDataKey,
  generateMachineKeyPair,
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

const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'))
const encoded = (value: Uint8Array) => Buffer.from(value).toString('base64url')
const isNotFound = (error: unknown) => error instanceof ConfigClientError && error.status === 404

export type RotationPlan = { reseal: ConfigSecret[]; retireDekIds: string[] }

export function planRotation(
  rows: ConfigSecret[],
  current: DataKey,
  keys: DataKey[],
): RotationPlan {
  const reseal = rows.filter((row) => row.dekId !== current.id)
  return {
    reseal,
    retireDekIds: keys
      .filter((key) => key.version < current.version && !key.retiredAt)
      .map((key) => key.id)
      .sort(),
  }
}

async function localMachine() {
  const pair = readMachineKey()
  if (!pair) throw new Error('machine key is not initialized; run `orch config machine init`')
  return machineKeyInfo(pair)
}

async function identity(client: ConfigClient) {
  return hostedIdentity(client)
}

async function unpinServerRevoked(client: ConfigClient) {
  const remote = await client.listMachineKeys()
  for (const key of remote) if (key.revokedAt) await unpinTrustedMachine(key.keyId)
  return remote
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
  const sender = trust[machine.keyId]
  if (!sender) throw new Error('this machine is absent from the trust list')
  return Promise.all(
    Object.entries(trust).map(async ([recipientKeyId, recipient]) => {
      const wrapped = await wrapDataKey({
        dek,
        wrapContext: { spaceId: who.spaceId, dekId, dekVersion: version },
        senderPrivateKey: machine.privateKey,
        senderPublicKey: bytes(sender.public_key),
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
    if (!isNotFound(error)) throw error
    await unpinServerRevoked(client)
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

export async function machineInit(
  label = hostname(),
  client = configClient(),
  env: ConfigEnvironment = process.env,
): Promise<string> {
  const pinned = readHostedConfigIdentity(env)
  const current = await client.whoami()
  if (!current.activeSpaceId) throw new Error(RECORD_ACTIVE_SPACE_REMEDY)
  if (pinned) {
    if (current.activeSpaceId !== pinned.spaceId)
      throw new Error(pinnedSpaceMismatchRemedy(pinned.spaceId))
    if (current.user.id !== pinned.userId) throw new Error(pinnedUserMismatchRemedy(pinned.userId))
  }
  const existing = readMachineKey(env)
  const pair = existing ?? (await generateMachineKeyPair())
  const keyId = await machineKeyId(pair.publicKey)
  if (!existing) writeMachineKey(pair, env)
  await pinTrustedMachine(keyId, pair.publicKey, label, env)
  if (!pinned)
    writeHostedConfigIdentity({ spaceId: current.activeSpaceId, userId: current.user.id }, env)
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
  const remote = await unpinServerRevoked(client)
  const registered = remote.find((item) => item.keyId === keyId)
  if (!registered || registered.revokedAt)
    throw new Error(`machine key ${keyId} is not registered and active in this space`)
  await pinTrustedMachine(keyId, publicBytes, label)
  const machine = await localMachine()
  const trust = await readTrustList()
  const sender = trust[machine.keyId]
  const recipient = trust[keyId]
  if (!sender || !recipient) throw new Error('machine is absent from the trust list after pinning')
  try {
    const current = await client.currentDataKey(machine.keyId)
    const dek = await unwrap(client, current, machine)
    const who = await identity(client)
    const wrapped = await wrapDataKey({
      dek,
      wrapContext: { spaceId: who.spaceId, dekId: current.id, dekVersion: current.version },
      senderPrivateKey: machine.privateKey,
      senderPublicKey: bytes(sender.public_key),
      recipientPublicKey: bytes(recipient.public_key),
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
    if (!isNotFound(error)) throw error
  }
}

async function rowPlaintext(
  client: ConfigClient,
  row: ConfigSecret,
  machine?: Awaited<ReturnType<typeof localMachine>>,
): Promise<Uint8Array> {
  const local = machine ?? (await localMachine())
  const key = await client.getDataKey(row.dekId, local.keyId)
  const full = await client.getSecret(row.key, row.scope, row.environment)
  return openHostedSecret({
    client,
    row: full,
    key,
    machine: local,
    trust: await readTrustList(),
    expected: { key: row.key, scope: row.scope, environment: row.environment },
  })
}

async function revokeIfNeeded(
  keyId: string,
  revokedAt: string | null | undefined,
  machine: Awaited<ReturnType<typeof localMachine>>,
  client: ConfigClient,
): Promise<string | null | undefined> {
  if (revokedAt) {
    await unpinTrustedMachine(keyId)
    return revokedAt
  }
  const trustBefore = await readTrustList()
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
      senderPublicKey: bytes(self.public_key),
      recipientPublicKey: bytes(self.public_key),
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
  await client.revokeMachineKey(keyId)
  await unpinTrustedMachine(keyId)
  return (await client.listMachineKeys()).find((item) => item.keyId === keyId)?.revokedAt
}

export async function machineRevoke(keyId: string, client = configClient()): Promise<string[]> {
  const machine = await localMachine()
  if (keyId === machine.keyId)
    throw new Error('cannot revoke this machine own key; revoke it from another trusted machine')
  const remote = await unpinServerRevoked(client)
  let revokedAt = remote.find((item) => item.keyId === keyId)?.revokedAt
  revokedAt = await revokeIfNeeded(keyId, revokedAt, machine, client)
  const trust = await readTrustList()
  let current = await client.currentDataKey(machine.keyId)
  const rows = await client.listSecrets(HOSTED_CONFIG_ENVIRONMENT)
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
  const plan = planRotation(rows, current, await client.listDataKeys())
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
    existing = await client.getSecret(key, scope, HOSTED_CONFIG_ENVIRONMENT)
  } catch (error) {
    if (!isNotFound(error)) throw error
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
      environment: HOSTED_CONFIG_ENVIRONMENT,
      dekId: dataKey.id,
      rowVersion,
    },
  })
  return client.putSecret(key, {
    scope,
    environment: HOSTED_CONFIG_ENVIRONMENT,
    dekId: dataKey.id,
    envelope: encoded(envelope),
    expectedRowVersion: existing?.rowVersion ?? null,
  })
}

export async function deleteSecret(key: string, scope: ConfigScope, client = configClient()) {
  const row = await client.getSecret(key, scope, HOSTED_CONFIG_ENVIRONMENT)
  return client.deleteSecret(key, {
    scope,
    environment: HOSTED_CONFIG_ENVIRONMENT,
    expectedRowVersion: row.rowVersion,
  })
}

export async function getEntry(key: string, scope: ConfigScope, client = configClient()) {
  return client.getEntry(key, scope, HOSTED_CONFIG_ENVIRONMENT)
}

export async function setEntry(
  key: string,
  value: string,
  scope: ConfigScope,
  expectedRowVersion?: number | null,
  client = configClient(),
) {
  const shipTo = isShipToConfigKey(key)
  const storedKey = shipTo ? SHIP_TO_CONFIG_KEY : key
  const storedValue = shipTo ? (storedShipToLevel(value) ?? value) : value
  let version = expectedRowVersion
  if (version === undefined) {
    version = null
    try {
      version = (await getEntry(storedKey, scope, client)).rowVersion
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
  const written = await client.putEntry(storedKey, {
    scope,
    environment: HOSTED_CONFIG_ENVIRONMENT,
    value: storedValue,
    expectedRowVersion: version,
  })
  if (shipTo) {
    try {
      const alias = await getEntry(STORED_SHIP_TO_CONFIG_ALIAS, scope, client)
      await deleteEntry(STORED_SHIP_TO_CONFIG_ALIAS, scope, alias.rowVersion, client)
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
  return written
}

export async function listEntries(client = configClient()) {
  return client.listEntries(HOSTED_CONFIG_ENVIRONMENT)
}

export async function deleteEntry(
  key: string,
  scope: ConfigScope,
  expectedRowVersion?: number,
  client = configClient(),
) {
  const version = expectedRowVersion ?? (await getEntry(key, scope, client)).rowVersion
  return client.deleteEntry(key, {
    scope,
    environment: HOSTED_CONFIG_ENVIRONMENT,
    expectedRowVersion: version,
  })
}

export function setMachineEntry(key: string, value: string) {
  setMachineAutonomy(key, value)
  const storedKey = isShipToConfigKey(key) ? SHIP_TO_CONFIG_KEY : key
  return listMachineAutonomy().find((row) => row.key === storedKey)!
}

export function deleteMachineEntry(key: string): void {
  deleteMachineAutonomy(key)
}

export function listMachineEntries() {
  return listMachineAutonomy()
}

export async function listSecrets(client = configClient()) {
  return client.listSecrets(HOSTED_CONFIG_ENVIRONMENT)
}
