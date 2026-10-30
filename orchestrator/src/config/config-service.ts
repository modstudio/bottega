// concern: config-command-service
/** Composes local bootstrap custody, hosted config operations, and pure rotation policy. */
import { hostname } from 'node:os'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
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
import type { StoredMachineNames } from '../../../shared/machine-config.ts'
import {
  type ConfigHome,
  configHomes,
  deleteMachineAutonomy,
  deleteMachineValue,
  isMachineConfigKey,
  isSubscriptionPriceKey,
  listMachineAutonomy,
  type MachineConfigKey,
  readMachineFileValue,
  readMachineValueWithSource,
  setMachineAutonomy,
  setMachineValue,
  validateAutonomyEntry,
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
import { sealedValueIsEmpty, stripTrailingNewline } from '../../../shared/sealed-value.ts'
import {
  generateDataKey,
  generateMachineKeyPair,
  sealValue,
  unwrapDataKey,
  wrapDataKey,
} from '../../../shared/secret-envelope.ts'
import {
  isShipToConfigKey,
  SHIP_TO_CONFIG_KEY,
  STORED_SHIP_TO_CONFIG_ALIAS,
  storedShipToLevel,
} from '../../../shared/ship-to.ts'
import {
  pinTrustedMachine,
  readTrustList,
  type TrustList,
  unpinTrustedMachine,
} from '../../../shared/trust-list.ts'
import { claimCurrentMachineNames } from '../record/machine-name-command.ts'
import { LEGACY_ENVIRONMENT_SECRET_NAMES } from '../setup/environment-name-migration.ts'

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
  if (!pair)
    throw new Error(
      `machine key is not initialized; run \`${PLATFORM_SLUG} machine config machine init\``,
    )
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
  names?: StoredMachineNames,
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
  if (names) await claimCurrentMachineNames(names)
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

/** The scope flag one `machine config secret` repair carries: the verbs declare only `--space`. */
function secretScopeFlag(scope: ConfigScope): string {
  return scope === 'space' ? ' --space' : ''
}

/** The one spelling of the repair that pipes a value into `secret set` in the given scope. */
export function secretSetRemedy(key: string, scope: ConfigScope): string {
  return `${PLATFORM_SLUG} machine config secret set ${key}${secretScopeFlag(scope)}`
}

/** The one spelling of the repair that removes a sealed value in the given scope. */
export function secretDeleteRemedy(key: string, scope: ConfigScope): string {
  return `${PLATFORM_SLUG} machine config secret delete ${key}${secretScopeFlag(scope)}`
}

/**
 * The one refusal for a value that would be sealed blank: it names the key, says no value was
 * sealed, and names both repairs in the scope the write would have used. A blank copy is refused
 * wherever it would enter the store, so the service and the command render the same text.
 */
export function sealedEmptyRefusal(key: string, scope: ConfigScope): string {
  return (
    `refusing to seal ${key}: the value piped on stdin is empty, so no value was sealed\n` +
    `cleared by: pipe the value on stdin to \`${secretSetRemedy(key, scope)}\`, or remove the sealed value with \`${secretDeleteRemedy(key, scope)}\``
  )
}

export type SealedSecretSetDecision =
  | { kind: 'seal'; value: string }
  | { kind: 'refuse'; refusal: string }

/**
 * Decide `machine config secret set` from the text piped on stdin, before anything is written.
 *
 * A blank value is the mistake `secret set` used to seal: `echo | ... secret set KEY` stored an
 * empty copy that later resolved as a present secret.
 */
export function sealSecretDecision(
  key: string,
  piped: string,
  scope: ConfigScope,
): SealedSecretSetDecision {
  if (!sealedValueIsEmpty(piped)) return { kind: 'seal', value: stripTrailingNewline(piped) }
  return { kind: 'refuse', refusal: sealedEmptyRefusal(key, scope) }
}

/**
 * Seal one secret. The service owns the invariant that a sealed value is never blank, so a blank
 * value is refused here before any read or write, not only at the command that pipes stdin.
 */
export async function setSecret(
  key: string,
  value: string,
  scope: ConfigScope,
  client = configClient(),
) {
  if (sealedValueIsEmpty(value)) throw new Error(sealedEmptyRefusal(key, scope))
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

export type SecretEnvironmentMigration = {
  oldName: string
  newName: string
  scope: ConfigScope
}

export type SecretEnvironmentDecision =
  | { kind: 'done' }
  | { kind: 'write-verify-delete'; value: string }
  | { kind: 'delete-old' }
  | { kind: 'refuse' }

/** Decide one scope without config, crypto, or network access. */
export function secretEnvironmentDecision(
  oldValue: string | null,
  newValue: string | null,
): SecretEnvironmentDecision {
  if (oldValue === null) return { kind: 'done' }
  if (newValue === null) return { kind: 'write-verify-delete', value: oldValue }
  if (oldValue === newValue) return { kind: 'delete-old' }
  return { kind: 'refuse' }
}

type SecretEnvironmentStore = {
  scopes(oldName: string, newName: string): Promise<ConfigScope[]>
  read(name: string, scope: ConfigScope): Promise<string | null>
  write(name: string, value: string, scope: ConfigScope): Promise<void>
  delete(name: string, scope: ConfigScope): Promise<void>
}

async function applySecretEnvironmentDecision(
  store: SecretEnvironmentStore,
  oldName: string,
  newName: string,
  scope: ConfigScope,
  decision: Exclude<SecretEnvironmentDecision, { kind: 'done' }>,
): Promise<void> {
  if (decision.kind === 'refuse') {
    throw new Error(
      `refusing sealed environment migration: ${oldName} and ${newName} differ in ${scope} scope; run \`${secretDeleteRemedy(oldName, scope)}\`, then re-run ${PLATFORM_SLUG} machine setup apply`,
    )
  }
  if (decision.kind === 'write-verify-delete') {
    await store.write(newName, decision.value, scope)
    if ((await store.read(newName, scope)) !== decision.value) {
      throw new Error(
        `refusing sealed environment migration: ${newName} did not verify after write in ${scope} scope; re-run ${PLATFORM_SLUG} machine setup apply`,
      )
    }
  }
  await store.delete(oldName, scope)
}

export async function applyLegacyEnvironmentSecretMigration(
  store: SecretEnvironmentStore,
  onMigrated: (migration: SecretEnvironmentMigration) => Promise<void> = async () => {},
): Promise<SecretEnvironmentMigration[]> {
  const migrations: SecretEnvironmentMigration[] = []
  for (const [oldName, newName] of LEGACY_ENVIRONMENT_SECRET_NAMES) {
    for (const scope of await store.scopes(oldName, newName)) {
      const oldValue = await store.read(oldName, scope)
      const newValue = await store.read(newName, scope)
      const decision = secretEnvironmentDecision(oldValue, newValue)
      if (decision.kind === 'done') continue
      await applySecretEnvironmentDecision(store, oldName, newName, scope, decision)
      const migration = { oldName, newName, scope }
      migrations.push(migration)
      await onMigrated(migration)
    }
  }
  return migrations
}

/** The config service has no rename verb, so setup opens, sets, and deletes in one operation. */
export async function migrateLegacyEnvironmentSecrets(
  client = configClient(),
  adapters: {
    plaintext?: (client: ConfigClient, row: ConfigSecret) => Promise<Uint8Array>
    write?: (
      name: string,
      value: string,
      scope: ConfigScope,
      client: ConfigClient,
    ) => Promise<unknown>
    delete?: (name: string, scope: ConfigScope, client: ConfigClient) => Promise<unknown>
    migrated?: (migration: SecretEnvironmentMigration) => Promise<void>
  } = {},
): Promise<SecretEnvironmentMigration[]> {
  const initial = await client.listSecrets(HOSTED_CONFIG_ENVIRONMENT)
  const read = async (name: string, scope: ConfigScope): Promise<string | null> => {
    let row: ConfigSecret
    try {
      row = await client.getSecret(name, scope, HOSTED_CONFIG_ENVIRONMENT)
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
    const plaintext = adapters.plaintext ?? rowPlaintext
    return new TextDecoder('utf-8', { fatal: true }).decode(await plaintext(client, row))
  }
  return applyLegacyEnvironmentSecretMigration(
    {
      scopes: async (oldName, newName) => [
        ...new Set(
          initial
            .filter((row) => row.key === oldName || row.key === newName)
            .map((row) => row.scope),
        ),
      ],
      read,
      write: async (name, value, scope) => {
        await (adapters.write ?? setSecret)(name, value, scope, client)
      },
      delete: async (name, scope) => {
        await (adapters.delete ?? deleteSecret)(name, scope, client)
      },
    },
    adapters.migrated,
  )
}

/** Reverse only the sealed-secret renames recorded by setup, without persisting plaintext. */
export async function restoreLegacyEnvironmentSecrets(
  migrations: ReadonlyArray<SecretEnvironmentMigration>,
  client = configClient(),
  adapters: {
    plaintext?: (client: ConfigClient, row: ConfigSecret) => Promise<Uint8Array>
    write?: (
      name: string,
      value: string,
      scope: ConfigScope,
      client: ConfigClient,
    ) => Promise<unknown>
    delete?: (name: string, scope: ConfigScope, client: ConfigClient) => Promise<unknown>
  } = {},
): Promise<void> {
  const plaintext = adapters.plaintext ?? rowPlaintext
  const read = async (name: string, scope: ConfigScope): Promise<string | null> => {
    try {
      const row = await client.getSecret(name, scope, HOSTED_CONFIG_ENVIRONMENT)
      return new TextDecoder('utf-8', { fatal: true }).decode(await plaintext(client, row))
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }
  const planned: Array<SecretEnvironmentMigration & { value: string }> = []
  for (const { oldName, newName, scope } of migrations) {
    const oldValue = await read(oldName, scope)
    const newValue = await read(newName, scope)
    if (oldValue !== null) {
      throw new Error(
        `refusing setup restore: sealed secret ${oldName} already exists in ${scope} scope; run \`${secretDeleteRemedy(oldName, scope)}\`, then re-run ${PLATFORM_SLUG} machine setup restore`,
      )
    }
    if (newValue === null) {
      throw new Error(
        `refusing setup restore: sealed secret ${newName} is absent in ${scope} scope; restore it, then re-run ${PLATFORM_SLUG} machine setup restore`,
      )
    }
    planned.push({ oldName, newName, scope, value: newValue })
  }
  for (const { oldName, newName, scope, value } of planned) {
    await (adapters.write ?? setSecret)(oldName, value, scope, client)
    if ((await read(oldName, scope)) !== value) {
      throw new Error(
        `refusing setup restore: sealed secret ${oldName} did not verify after write in ${scope} scope; re-run ${PLATFORM_SLUG} machine setup restore`,
      )
    }
    await (adapters.delete ?? deleteSecret)(newName, scope, client)
  }
}

export async function getEntry(key: string, scope: ConfigScope, client = configClient()) {
  return client.getEntry(key, scope, HOSTED_CONFIG_ENVIRONMENT)
}

export type { ConfigHome }
export type ConfigReadResult = {
  key: string
  value: string
  home: ConfigHome
  source: string
  ignoredHostedScopes: ConfigScope[]
  outrankingMachineValue?: string
  row?: Awaited<ReturnType<typeof getEntry>>
}

function acceptedHomes(key: string): readonly ConfigHome[] {
  const homes = configHomes(key)
  if (homes) return homes
  throw new Error(
    `refusing config key ${key}: accepted families are machine catalogue keys, autonomy.*, and subscription.<harness>.monthly_usd; inspect machine keys with \`${PLATFORM_SLUG} machine config list --machine\``,
  )
}

function homeLabel(home: ConfigHome): string {
  return home === 'machine' ? 'machine' : `hosted ${home} scope`
}

function setRemedy(key: string, home: ConfigHome): string {
  const flag = home === 'machine' ? '--machine ' : home === 'space' ? '--space ' : ''
  return `${PLATFORM_SLUG} machine config set ${flag}${key} <value>`
}

function getRemedy(key: string): string {
  const homes = configHomes(key) ?? []
  const flags = [
    ...(homes.includes('machine') ? ['--machine'] : []),
    ...(homes.includes('space') ? ['--space'] : []),
  ]
  const selector = homes.includes('user')
    ? flags.length
      ? ` [${flags.join('|')}]`
      : ''
    : ` ${flags.join('|')}`
  return `${PLATFORM_SLUG} machine config get${selector} ${key}`
}

export function configHome(
  key: string,
  requested?: ConfigHome,
  operation: 'get' | 'set' = 'set',
): ConfigHome {
  const homes = acceptedHomes(key)
  const chosen = requested ?? homes[0]!
  if (homes.includes(chosen)) return chosen
  const home = homes[0]!
  const remedy =
    operation === 'get'
      ? `read it with \`${getRemedy(key)}\``
      : `write it with \`${setRemedy(key, home)}\``
  throw new Error(
    `refusing config key ${key} in ${homeLabel(chosen)}: its home is ${homeLabel(home)}; ${remedy}`,
  )
}

function validateHostedValue(key: string, value: string): void {
  if (key.startsWith('autonomy.')) {
    validateAutonomyEntry(key, value)
    return
  }
  if (isSubscriptionPriceKey(key)) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0)
      throw new Error(`refusing config key ${key}: value must be a non-negative number`)
  }
}

export async function setConfigEntry(
  key: string,
  value: string,
  requested: ConfigHome | undefined,
  expectedRowVersion?: number | null,
  client: ConfigClient | undefined = undefined,
  env: ConfigEnvironment = process.env,
  clientFactory: () => ConfigClient = () => configClient(env),
) {
  const home = configHome(key, requested)
  if (home === 'machine') {
    if (expectedRowVersion !== undefined)
      throw new Error(
        `refusing config key ${key}: --expect applies only to hosted values; write its machine home with \`${setRemedy(key, home)}\``,
      )
    const row = setMachineEntry(key, value, env)
    return { key: row.key, value: String(row.value), home, row }
  }
  validateHostedValue(key, value)
  const row = await setEntry(key, value, home, expectedRowVersion, client ?? clientFactory())
  return { key: row.key, value: row.value, home, row }
}

function machineSourceLabel(source: ReturnType<typeof readMachineValueWithSource>['source']) {
  if (source.kind === 'environment') return `environment ${source.name}`
  if (source.kind === 'machine-file') return 'machine.toml'
  return 'default'
}

async function ignoredHostedScopes(
  key: string,
  clientFactory: () => ConfigClient,
): Promise<ConfigScope[]> {
  try {
    const rows = await clientFactory().listEntries(HOSTED_CONFIG_ENVIRONMENT)
    return rows
      .filter((row) => row.key === key)
      .map((row) => row.scope)
      .sort()
  } catch (error) {
    if (error instanceof ConfigClientError && error.reason === 'not-configured') return []
    throw error
  }
}

export async function getConfigEntry(
  key: string,
  requested: ConfigHome | undefined,
  client: ConfigClient | undefined = undefined,
  env: ConfigEnvironment = process.env,
  clientFactory: () => ConfigClient = () => configClient(env),
): Promise<ConfigReadResult> {
  const home = configHome(key, requested, 'get')
  if (home === 'machine') {
    if (key.startsWith('autonomy.')) {
      const row = listMachineAutonomy(env).find((candidate) => candidate.key === key)
      if (!row)
        throw new Error(
          `machine.toml has no value for ${key}; write it with \`${setRemedy(key, 'machine')}\``,
        )
      return {
        key,
        value: row.value,
        home,
        source: 'machine.toml',
        ignoredHostedScopes: [],
      }
    }
    const machineKey = key as MachineConfigKey
    if (requested === 'machine') {
      const value = readMachineFileValue(machineKey, env)
      if (value === undefined)
        throw new Error(
          `machine.toml has no value for ${key}; write it with \`${setRemedy(key, 'machine')}\``,
        )
      return {
        key,
        value: String(value),
        home,
        source: 'machine.toml',
        ignoredHostedScopes: [],
      }
    }
    const resolved = readMachineValueWithSource(machineKey, env)
    return {
      key,
      value: String(resolved.value),
      home,
      source: machineSourceLabel(resolved.source),
      ignoredHostedScopes: await ignoredHostedScopes(key, () => client ?? clientFactory()),
    }
  }
  const row = await getEntry(key, home, client ?? clientFactory())
  const machineRow = key.startsWith('autonomy.')
    ? listMachineAutonomy(env).find((candidate) => candidate.key === key)
    : undefined
  return {
    key: row.key,
    value: row.value,
    home,
    source: `hosted ${home} scope`,
    ignoredHostedScopes: [],
    outrankingMachineValue: machineRow?.value,
    row,
  }
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

function setMachineEntry(key: string, value: string, env: ConfigEnvironment = process.env) {
  if (isMachineConfigKey(key)) {
    const stored = setMachineValue(key, value, env)
    return { key, value: String(stored), scope: 'machine' as const }
  }
  setMachineAutonomy(key, value, env)
  const storedKey = isShipToConfigKey(key) ? SHIP_TO_CONFIG_KEY : key
  return listMachineAutonomy(env).find((row) => row.key === storedKey)!
}

export function deleteMachineEntry(key: string, env: ConfigEnvironment = process.env): void {
  if (isMachineConfigKey(key)) {
    deleteMachineValue(key, env)
    return
  }
  if (!configHomes(key)?.includes('machine'))
    throw new Error(
      `refusing machine config key ${key}: accepted families are machine catalogue keys and autonomy.*; inspect machine keys with \`${PLATFORM_SLUG} machine config list --machine\``,
    )
  deleteMachineAutonomy(key, env)
}

export async function listSecrets(client = configClient()) {
  return client.listSecrets(HOSTED_CONFIG_ENVIRONMENT)
}
