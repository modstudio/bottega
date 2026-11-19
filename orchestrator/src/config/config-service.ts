// concern: config-command-service
/** Composes local bootstrap custody, hosted config operations, and pure rotation policy. */
import { hostname } from 'node:os'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type ConfigClient,
  ConfigClientError,
  type ConfigDestination,
  type ConfigScope,
  type ConfigSecret,
  type DataKey,
  type ConfigWriteDestination as WriteDestination,
} from '../../../shared/config-client.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import type { CredentialMetadataFields, CredentialMode } from '../../../shared/credential.ts'
import {
  readHostedConfigIdentity,
  writeHostedConfigIdentity,
} from '../../../shared/hosted-config-space.ts'
import { HOSTED_CONFIG_ENVIRONMENT, hostedIdentity } from '../../../shared/hosted-secret-opening.ts'
import { localMachine, openHostedSecretRow } from '../../../shared/hosted-secret-row.ts'
import {
  type ConfigHome,
  configHomes,
  DISPLAY_TIMEZONE_KEY,
  deleteMachineAutonomy,
  deleteMachineValue,
  isDisplayTimezone,
  isMachineConfigKey,
  listMachineAutonomy,
  type MachineConfigKey,
  readMachineFileValue,
  readMachineValueWithSource,
  setMachineAutonomy,
  setMachineValue,
} from '../../../shared/machine-config.ts'
import { machineKeyId } from '../../../shared/machine-key-id.ts'
import {
  readMachineKey,
  replaceRevokedMachineKey,
  writeMachineKey,
} from '../../../shared/machine-key-store.ts'
import {
  generateMachineSigningKeyPair,
  readMachineSigningKey,
  replaceRevokedMachineSigningKey,
  writeMachineSigningKey,
} from '../../../shared/machine-signing-key.ts'
import {
  pinnedSpaceMismatchRemedy,
  pinnedUserMismatchRemedy,
  RECORD_ACTIVE_SPACE_REMEDY,
} from '../../../shared/record-remedies.ts'
import { sealedValueIsEmpty } from '../../../shared/sealed-value.ts'
import {
  generateDataKey,
  generateMachineKeyPair,
  sealValue,
  wrapDataKey,
} from '../../../shared/secret-envelope.ts'
import {
  isShipToConfigKey,
  SHIP_TO_CONFIG_KEY,
  STORED_SHIP_TO_CONFIG_ALIAS,
  storedShipToLevel,
} from '../../../shared/ship-to.ts'
import { pinTrustedMachine, unpinTrustedMachine } from '../../../shared/trust-list.ts'
import {
  type TrustedKeys,
  trustedKeysForSpace,
  trustForSpace,
} from '../../../shared/trust-log-keys.ts'
import type { MachineNamePair } from '../record/machine-name.ts'
import { claimCurrentMachineNames } from '../record/machine-name-command.ts'
import { LEGACY_ENVIRONMENT_SECRET_NAMES } from '../setup/environment-name-migration.ts'
import * as configEntryPolicy from './config-entry-policy.ts'
import { planRotation, shouldRotateAfterRevocation } from './config-service-rotation-policy.ts'
import { verifyConfigWrite } from './config-write-verification.ts'
import {
  bytes,
  claimMachineKey,
  DataKeyWrapAccessError,
  encoded,
  isNotFound,
  openDataKey,
  wrapRecipientKeyIds,
  wrapsForRecipients,
} from './data-key-access.ts'
import { refreshDisplayTimezoneCache } from './display-timezone-cache.ts'
import { hostedConfigClient } from './hosted-config-call-outcome.ts'
import * as trustRefusal from './machine-trust-refusal.ts'
import { personalConfigWriteDestination } from './personal-config-write-destination.ts'
import { sealedEmptyRefusal, secretDeleteRemedy, secretSetRemedy } from './secret-set-policy.ts'
import { pinnedConfigDestination } from './secret-write-target.ts'
import { verifySecretWrite } from './secret-write-verification.ts'
import { appendTrustLogRevoke } from './trust-log-revoke.ts'

async function identity(client: ConfigClient, env: ConfigEnvironment = process.env) {
  return hostedIdentity(client, readHostedConfigIdentity(env))
}

export { personalConfigWriteDestination }

async function unpinServerRevoked(client: ConfigClient, destination: ConfigDestination = {}) {
  const remote = await client.listMachineKeys(destination)
  for (const key of remote) if (key.revokedAt) await unpinTrustedMachine(key.keyId)
  return remote
}

async function unwrap(
  client: ConfigClient,
  key: DataKey,
  machine?: Awaited<ReturnType<typeof localMachine>>,
  trust?: TrustedKeys,
  destinationSpaceId?: string,
) {
  const local = machine ?? (await localMachine())
  const spaceId = destinationSpaceId ?? (await identity(client)).spaceId
  const trusted = trust ?? (await trustedKeysForSpace(client, spaceId))
  return openDataKey(key, spaceId, local, trusted)
}

async function wrapsFor(
  dek: Uint8Array,
  dekId: string,
  version: number,
  trust: TrustedKeys,
  client: ConfigClient,
  destinationSpaceId?: string,
  env: ConfigEnvironment = process.env,
) {
  const machine = await localMachine(env)
  const spaceId = destinationSpaceId ?? (await identity(client, env)).spaceId
  const recipientKeyIds = wrapRecipientKeyIds(
    await client.listMachineKeys({ destinationSpaceId: spaceId }),
    trust,
  )
  return wrapsForRecipients(
    dek,
    { spaceId, dekId, dekVersion: version },
    machine,
    trust,
    recipientKeyIds,
  )
}

async function currentOrCreate(
  client: ConfigClient,
  destination: WriteDestination,
  createDataKey = true,
  missingDestinationAccessRefusal?: () => Error,
) {
  const machine = await localMachine()
  try {
    const key = await client.currentDataKey(machine.keyId, destination)
    try {
      await unwrap(client, key, machine, undefined, destination.destinationSpaceId)
    } catch (error) {
      if (error instanceof DataKeyWrapAccessError && missingDestinationAccessRefusal)
        throw missingDestinationAccessRefusal()
      throw error
    }
    const remote = await unpinServerRevoked(client, destination)
    const rotated = await rotateAfterLatestRevocation(
      client,
      machine,
      key,
      remote,
      destination.destinationSpaceId,
      destination,
    )
    return { key: rotated.key, dek: rotated.dek }
  } catch (error) {
    if (!isNotFound(error)) throw error
    if (!createDataKey) throw error
    await unpinServerRevoked(client, destination)
    const spaceId = destination.destinationSpaceId
    const trust = await trustedKeysForSpace(client, spaceId)
    const dek = generateDataKey()
    const dekId = crypto.randomUUID()
    const version = 1
    await client.createDataKey(
      {
        dekId,
        version,
        wraps: await wrapsFor(dek, dekId, version, trust, client, spaceId),
      },
      destination,
    )
    return { key: await client.getDataKey(dekId, machine.keyId, destination), dek }
  }
}

export async function machineInit(
  selectedSpaceId: string,
  label = hostname(),
  client = hostedConfigClient(),
  env: ConfigEnvironment = process.env,
  names?: MachineNamePair,
): Promise<string> {
  const pinned = readHostedConfigIdentity(env)
  const current = await client.whoami()
  if (pinned) {
    if (selectedSpaceId !== pinned.spaceId)
      throw new Error(pinnedSpaceMismatchRemedy(pinned.spaceId))
    if (current.user.id !== pinned.userId) throw new Error(pinnedUserMismatchRemedy(pinned.userId))
  }
  const existing = readMachineKey(env)
  let signingPair = readMachineSigningKey(env)
  if (!signingPair) {
    signingPair = generateMachineSigningKeyPair()
    writeMachineSigningKey(signingPair, env)
  }
  let pair = existing ?? (await generateMachineKeyPair())
  let keyId = await machineKeyId(pair.publicKey)
  const destination = { destinationSpaceId: selectedSpaceId }
  if (existing) {
    const registered = (await client.listMachineKeys(destination)).find(
      (key) => key.keyId === keyId,
    )
    if (registered?.revokedAt) {
      const replacement = await generateMachineKeyPair()
      const signingReplacement = generateMachineSigningKeyPair()
      replaceRevokedMachineKey(keyId, replacement, env)
      replaceRevokedMachineSigningKey(keyId, signingReplacement, env)
      await unpinTrustedMachine(keyId, env)
      pair = replacement
      signingPair = signingReplacement
      keyId = await machineKeyId(pair.publicKey)
    }
  } else writeMachineKey(pair, env)
  await pinTrustedMachine(keyId, pair.publicKey, label, env)
  if (!pinned) writeHostedConfigIdentity({ spaceId: selectedSpaceId, userId: current.user.id }, env)
  const registered = await client.registerMachineKey(
    keyId,
    encoded(pair.publicKey),
    label,
    destination,
    encoded(signingPair.publicKey),
  )
  if (registered.userId === null)
    await claimMachineKey(pair, keyId, selectedSpaceId, client, destination)
  if (names) await claimCurrentMachineNames(names)
  return keyId
}

export async function claimCurrentMachineKey(
  client = hostedConfigClient(),
  env: ConfigEnvironment = process.env,
): Promise<void> {
  const pair = readMachineKey(env)
  if (!pair) return
  const keyId = await machineKeyId(pair.publicKey)
  const registered = (await client.listMachineKeys()).find((key) => key.keyId === keyId)
  if (!registered || registered.userId !== null) return
  const current = await client.whoami()
  if (!current.activeSpaceId) throw new Error(RECORD_ACTIVE_SPACE_REMEDY)
  await claimMachineKey(pair, keyId, current.activeSpaceId, client, {
    destinationSpaceId: current.activeSpaceId,
  })
}

export async function machineShow() {
  const machine = await localMachine()
  return { keyId: machine.keyId, publicKey: encoded(machine.publicKey) }
}

export async function machineTrust(
  keyId: string,
  publicKey: string,
  label: string,
  selected: { spaceId: string; slug: string },
  client = hostedConfigClient(),
  env: ConfigEnvironment = process.env,
) {
  const destination = { destinationSpaceId: selected.spaceId }
  const publicBytes = bytes(publicKey)
  if ((await machineKeyId(publicBytes)) !== keyId)
    throw new Error('machine key id does not match public key')
  const keys = await client.listMachineKeys(destination)
  for (const key of keys) if (key.revokedAt) await unpinTrustedMachine(key.keyId, env)
  const registered = keys.find((item) => item.keyId === keyId)
  const refusal = trustRefusal.machineTrustRefusal(keyId, registered, selected.slug)
  if (refusal) throw new Error(refusal)
  const machine = await localMachine(env)
  const beforePin = await trustForSpace(client, selected.spaceId, env)
  const keyIds = { local: machine.keyId, target: keyId }
  const anchoredRefusal = trustRefusal.anchoredTrustRefusal(beforePin, keyIds, selected.slug)
  if (anchoredRefusal) throw new Error(anchoredRefusal)
  await pinTrustedMachine(keyId, publicBytes, label, env)
  const trust = await trustedKeysForSpace(client, selected.spaceId, env)
  const [sender, recipient] = [trust[machine.keyId], trust[keyId]]
  if (!sender) throw new Error('machine is absent from the trust list after pinning')
  if (!recipient) throw new Error(trustRefusal.missingTrustLogKeyRefusal(keyId, selected.slug))
  try {
    const before = await client.currentDataKey(machine.keyId, destination)
    const {
      key: current,
      dek,
      rotated,
    } = await rotateAfterLatestRevocation(
      client,
      machine,
      before,
      keys,
      selected.spaceId,
      destination,
      env,
    )
    if (rotated) return
    const wrapped = await wrapDataKey({
      dek,
      wrapContext: { spaceId: selected.spaceId, dekId: current.id, dekVersion: current.version },
      senderPrivateKey: machine.privateKey,
      senderPublicKey: bytes(sender.public_key),
      recipientPublicKey: bytes(recipient.public_key),
    })
    await client.addWraps(
      current.id,
      [
        {
          recipientKeyId: keyId,
          senderKeyId: machine.keyId,
          enc: encoded(wrapped.enc),
          ciphertext: encoded(wrapped.ciphertext),
        },
      ],
      destination,
    )
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
}

async function rotateDataKey(
  client: ConfigClient,
  machine: Awaited<ReturnType<typeof localMachine>>,
  currentBefore: DataKey,
  trust: TrustedKeys,
  rotate: boolean,
  selectedSpaceId?: string,
  destination: ConfigDestination = {},
  env: ConfigEnvironment = process.env,
): Promise<{ key: DataKey; dek: Uint8Array; completed: string[]; rotated: boolean }> {
  const rotationDestination: WriteDestination = {
    ...destination,
    destinationSpaceId: selectedSpaceId ?? (await identity(client, env)).spaceId,
  }
  let current = currentBefore
  let dek: Uint8Array
  if (rotate) {
    dek = generateDataKey()
    const dekId = crypto.randomUUID()
    const version = current.version + 1
    await client.createDataKey(
      {
        dekId,
        version,
        wraps: await wrapsFor(dek, dekId, version, trust, client, selectedSpaceId, env),
      },
      rotationDestination,
    )
    current = await client.getDataKey(dekId, machine.keyId, rotationDestination)
  } else {
    dek = await unwrap(client, current, machine, trust, selectedSpaceId)
  }
  const rows = await client.listSecrets(null, rotationDestination)
  const plan = planRotation(rows, current, await client.listDataKeys(rotationDestination))
  const completed: string[] = []
  try {
    const who = await identity(client, env)
    for (const row of plan.reseal) {
      const plaintext = await openHostedSecretRow(
        client,
        row,
        { ...rotationDestination, projectId: row.projectId ?? null },
        machine,
      )
      const envelope = sealValue({
        dek,
        plaintext,
        valueContext: {
          spaceId: rotationDestination.destinationSpaceId,
          userId: row.scope === 'user' ? who.userId : null,
          keyName: row.key,
          environment: row.environment,
          dekId: current.id,
          rowVersion: row.rowVersion + 1,
        },
      })
      await client.putSecret(
        row.key,
        {
          scope: row.scope,
          environment: row.environment,
          projectId: row.projectId ?? null,
          provider: row.provider ?? null,
          name: row.name ?? null,
          type: row.type ?? null,
          hint: row.hint ?? null,
          mode: row.mode ?? null,
          dekId: current.id,
          envelope: encoded(envelope),
          expectedRowVersion: row.rowVersion,
        },
        { ...rotationDestination, projectId: row.projectId ?? null },
      )
      completed.push(`${row.scope}:${row.environment}:${row.key}`)
    }
    for (const oldId of plan.retireDekIds) await client.retireDataKey(oldId, rotationDestination)
    return { key: current, dek, completed, rotated: rotate }
  } catch (error) {
    throw new Error(
      `rotation stopped after re-sealing rows [${completed.join(', ')}]: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function rotateAfterLatestRevocation(
  client: ConfigClient,
  machine: Awaited<ReturnType<typeof localMachine>>,
  current: DataKey,
  remote: readonly { revokedAt: string | null }[],
  selectedSpaceId?: string,
  destination: ConfigDestination = {},
  env: ConfigEnvironment = process.env,
) {
  return rotateDataKey(
    client,
    machine,
    current,
    await trustedKeysForSpace(
      client,
      selectedSpaceId ?? (await identity(client, env)).spaceId,
      env,
    ),
    shouldRotateAfterRevocation(current, remote),
    selectedSpaceId,
    destination,
    env,
  )
}

async function revokeIfNeeded(
  keyId: string,
  revokedAt: string | null | undefined,
  machine: Awaited<ReturnType<typeof localMachine>>,
  client: ConfigClient,
): Promise<string | null | undefined> {
  if (revokedAt) {
    const who = await identity(client)
    await appendTrustLogRevoke(client, machine.keyId, keyId, who.spaceId)
    await unpinTrustedMachine(keyId)
    return revokedAt
  }
  const who = await identity(client)
  const destination = { destinationSpaceId: who.spaceId }
  const trustBefore = await trustedKeysForSpace(client, who.spaceId)
  const currentBefore = await client.currentDataKey(machine.keyId)
  const oldDek = await unwrap(client, currentBefore, machine, trustBefore)
  if (!currentBefore.wraps.some((wrap) => wrap.senderKeyId === machine.keyId)) {
    const self = trustBefore[machine.keyId]
    if (!self) throw new Error('this machine is absent from the trust list')
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
    await client.addWraps(
      currentBefore.id,
      [
        {
          recipientKeyId: machine.keyId,
          senderKeyId: machine.keyId,
          enc: encoded(wrapped.enc),
          ciphertext: encoded(wrapped.ciphertext),
        },
      ],
      destination,
    )
  }
  await appendTrustLogRevoke(client, machine.keyId, keyId, who.spaceId)
  await client.revokeMachineKey(keyId, destination)
  await unpinTrustedMachine(keyId)
  return (await client.listMachineKeys()).find((item) => item.keyId === keyId)?.revokedAt
}

export async function machineRevoke(
  keyId: string,
  client = hostedConfigClient(),
): Promise<string[]> {
  const machine = await localMachine()
  if (keyId === machine.keyId)
    throw new Error('cannot revoke this machine own key; revoke it from another trusted machine')
  const remote = await unpinServerRevoked(client)
  let revokedAt = remote.find((item) => item.keyId === keyId)?.revokedAt
  revokedAt = await revokeIfNeeded(keyId, revokedAt, machine, client)
  const current = await client.currentDataKey(machine.keyId)
  const result = await rotateAfterLatestRevocation(client, machine, current, [
    { revokedAt: revokedAt ?? null },
  ])
  return result.completed
}

/**
 * Seal one secret. The service owns the invariant that a sealed value is never blank, so a blank
 * value is refused here before any read or write, not only at the command that pipes stdin.
 */
export async function setSecret(
  key: string,
  value: string,
  scope: ConfigScope,
  client = hostedConfigClient(),
  options: {
    destination: WriteDestination
    environment?: string
    metadata?: CredentialMetadataFields & {
      projectId: string | null
      mode: CredentialMode
      reachSpaceIds?: string[] | null
    }
    createDataKey?: boolean
    expectedRowVersion?: number
    missingDestinationAccessRefusal?: () => Error
    remedy: string
  },
) {
  if (sealedValueIsEmpty(value)) throw new Error(sealedEmptyRefusal(key, scope))
  const destination = options.destination
  const environment = options.environment ?? HOSTED_CONFIG_ENVIRONMENT
  const { key: dataKey, dek } = await currentOrCreate(
    client,
    destination,
    options.createDataKey ?? true,
    options.missingDestinationAccessRefusal,
  )
  let existing: ConfigSecret | null = null
  try {
    existing = await client.getSecret(key, scope, environment, destination)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  if (
    options.expectedRowVersion !== undefined &&
    existing?.rowVersion !== options.expectedRowVersion
  )
    throw new Error(
      `config secret row version conflict: expected ${options.expectedRowVersion}, current ${existing?.rowVersion ?? 'missing'}; read it again and retry`,
    )
  const who = await identity(client)
  const spaceId = destination.destinationSpaceId
  const rowVersion = (existing?.rowVersion ?? 0) + 1
  const envelope = sealValue({
    dek,
    plaintext: new TextEncoder().encode(value),
    valueContext: {
      spaceId,
      userId: scope === 'user' ? who.userId : null,
      keyName: key,
      environment,
      dekId: dataKey.id,
      rowVersion,
    },
  })
  const written = await client.putSecret(
    key,
    {
      scope,
      environment,
      dekId: dataKey.id,
      envelope: encoded(envelope),
      expectedRowVersion: existing?.rowVersion ?? null,
      ...(options.metadata ?? {}),
    },
    destination,
  )
  await verifySecretWrite(
    client,
    { key, scope, environment, rowVersion, dekId: dataKey.id },
    destination,
    options.remedy,
  )
  return written
}

export async function deleteSecret(
  key: string,
  scope: ConfigScope,
  client = hostedConfigClient(),
  options: { destination: WriteDestination; environment?: string },
) {
  const destination = options.destination
  const environment = options.environment ?? HOSTED_CONFIG_ENVIRONMENT
  const row = await client.getSecret(key, scope, environment, destination)
  return client.deleteSecret(
    key,
    { scope, environment, expectedRowVersion: row.rowVersion },
    destination,
  )
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

function legacySecretNamedSpaceRefusal(name: string, scope: ConfigScope): Error {
  return new Error(
    `refusing setup sealed-secret migration for ${name} in ${scope} scope: setup only writes user-scope secrets to the personal space; write the secret into a named space with \`${PLATFORM_SLUG} machine config secret set ${name} --space <slug>\``,
  )
}

type AdapterContext = [ConfigScope, ConfigClient, WriteDestination]
type LegacySecretMigrationAdapters = {
  plaintext?: (client: ConfigClient, row: ConfigSecret) => Promise<Uint8Array>
  write?: (name: string, value: string, ...context: AdapterContext) => Promise<unknown>
  delete?: (name: string, ...context: AdapterContext) => Promise<unknown>
}

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
  client = hostedConfigClient(),
  adapters: LegacySecretMigrationAdapters & {
    migrated?: (migration: SecretEnvironmentMigration) => Promise<void>
  } = {},
): Promise<SecretEnvironmentMigration[]> {
  const destination = await pinnedConfigDestination(client)
  const initial = await client.listSecrets(HOSTED_CONFIG_ENVIRONMENT, destination)
  const nonUser = initial.find(
    (row) =>
      row.scope !== 'user' &&
      LEGACY_ENVIRONMENT_SECRET_NAMES.some(
        ([oldName, newName]) => row.key === oldName || row.key === newName,
      ),
  )
  if (nonUser) throw legacySecretNamedSpaceRefusal(nonUser.key, nonUser.scope)
  const read = async (name: string, scope: ConfigScope): Promise<string | null> => {
    let row: ConfigSecret
    try {
      row = await client.getSecret(name, scope, HOSTED_CONFIG_ENVIRONMENT, destination)
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
    const plaintext = adapters.plaintext ?? openHostedSecretRow
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
        if (scope !== 'user') throw legacySecretNamedSpaceRefusal(name, scope)
        if (adapters.write) await adapters.write(name, value, scope, client, destination)
        else
          await setSecret(name, value, scope, client, {
            destination,
            remedy: secretSetRemedy(name, scope),
          })
      },
      delete: async (name, scope) => {
        if (scope !== 'user') throw legacySecretNamedSpaceRefusal(name, scope)
        if (adapters.delete) await adapters.delete(name, scope, client, destination)
        else await deleteSecret(name, scope, client, { destination })
      },
    },
    adapters.migrated,
  )
}

/** Reverse only the sealed-secret renames recorded by setup, without persisting plaintext. */
export async function restoreLegacyEnvironmentSecrets(
  migrations: ReadonlyArray<SecretEnvironmentMigration>,
  client = hostedConfigClient(),
  adapters: LegacySecretMigrationAdapters = {},
): Promise<void> {
  const unsupported = migrations.find((migration) => migration.scope !== 'user')
  if (unsupported) throw legacySecretNamedSpaceRefusal(unsupported.newName, unsupported.scope)
  const destination = await pinnedConfigDestination(client)
  const plaintext = adapters.plaintext ?? openHostedSecretRow
  const read = async (name: string, scope: ConfigScope): Promise<string | null> => {
    try {
      const row = await client.getSecret(name, scope, HOSTED_CONFIG_ENVIRONMENT, destination)
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
    if (adapters.write) await adapters.write(oldName, value, scope, client, destination)
    else
      await setSecret(oldName, value, scope, client, {
        destination,
        remedy: secretSetRemedy(oldName, scope),
      })
    if ((await read(oldName, scope)) !== value) {
      throw new Error(
        `refusing setup restore: sealed secret ${oldName} did not verify after write in ${scope} scope; re-run ${PLATFORM_SLUG} machine setup restore`,
      )
    }
    if (adapters.delete) await adapters.delete(newName, scope, client, destination)
    else await deleteSecret(newName, scope, client, { destination })
  }
}

export async function getEntry(
  key: string,
  scope: ConfigScope,
  client = hostedConfigClient(),
  destination: ConfigDestination = {},
) {
  return client.getEntry(key, scope, HOSTED_CONFIG_ENVIRONMENT, destination)
}

export { configHome } from './config-entry-policy.ts'
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

export async function setConfigEntry(
  key: string,
  value: string,
  requested: ConfigHome | undefined,
  expectedRowVersion?: number | null,
  client: ConfigClient | undefined = undefined,
  env: ConfigEnvironment = process.env,
  clientFactory: () => ConfigClient = () => hostedConfigClient(env),
  options: { destination?: WriteDestination; remedy?: string } = {},
): Promise<
  | { home: 'machine'; row: ReturnType<typeof setMachineEntry> }
  | { home: 'user' | 'space'; row: Awaited<ReturnType<typeof setEntry>> }
> {
  const home = configEntryPolicy.configHome(key, requested)
  if (home === 'machine') {
    if (expectedRowVersion !== undefined)
      throw new Error(
        `refusing config key ${key}: --expect applies only to hosted values; write its machine home with \`${configEntryPolicy.setRemedy(key, home)}\``,
      )
    const row = setMachineEntry(key, value, env)
    return { home, row }
  }
  configEntryPolicy.validateHostedValue(key, value)
  const hostedClient = client ?? clientFactory()
  const row = await setEntry(
    key,
    value,
    home,
    expectedRowVersion,
    hostedClient,
    options.destination ?? (await personalConfigWriteDestination(hostedClient)),
  )
  if (home === 'space' && options.destination && options.remedy)
    await verifyConfigWrite(hostedClient, row, options.destination, options.remedy)
  if (key === DISPLAY_TIMEZONE_KEY) refreshDisplayTimezoneCache(value, env)
  return { home, row }
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
  clientFactory: () => ConfigClient = () => hostedConfigClient(env),
  destination: ConfigDestination = {},
): Promise<ConfigReadResult> {
  const home = configEntryPolicy.configHome(key, requested, 'get')
  if (home === 'machine') {
    if (key.startsWith('autonomy.')) {
      const row = listMachineAutonomy(env).find((candidate) => candidate.key === key)
      if (!row)
        throw new Error(
          `machine.toml has no value for ${key}; write it with \`${configEntryPolicy.setRemedy(key, 'machine')}\``,
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
          `machine.toml has no value for ${key}; write it with \`${configEntryPolicy.setRemedy(key, 'machine')}\``,
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
      source: configEntryPolicy.machineSourceLabel(resolved.source),
      ignoredHostedScopes: await ignoredHostedScopes(key, () => client ?? clientFactory()),
    }
  }
  const row = await getEntry(key, home, client ?? clientFactory(), destination)
  if (key === DISPLAY_TIMEZONE_KEY) {
    if (!isDisplayTimezone(row.value)) {
      refreshDisplayTimezoneCache(null, env)
      throw new Error(
        `hosted user scope has no value for ${DISPLAY_TIMEZONE_KEY}; write it with \`${configEntryPolicy.setRemedy(DISPLAY_TIMEZONE_KEY, 'user')}\``,
      )
    }
    refreshDisplayTimezoneCache(row.value, env)
  }
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
  expectedRowVersion: number | null | undefined,
  client: ConfigClient,
  destination: WriteDestination,
) {
  const shipTo = isShipToConfigKey(key)
  const storedKey = shipTo ? SHIP_TO_CONFIG_KEY : key
  const storedValue = shipTo ? (storedShipToLevel(value) ?? value) : value
  let version = expectedRowVersion
  if (version === undefined) {
    version = null
    try {
      version = (await getEntry(storedKey, scope, client, destination)).rowVersion
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
  const written = await client.putEntry(
    storedKey,
    {
      scope,
      environment: HOSTED_CONFIG_ENVIRONMENT,
      value: storedValue,
      expectedRowVersion: version,
    },
    destination,
  )
  if (shipTo) {
    try {
      const alias = await getEntry(STORED_SHIP_TO_CONFIG_ALIAS, scope, client, destination)
      await deleteEntry(STORED_SHIP_TO_CONFIG_ALIAS, scope, alias.rowVersion, client, destination)
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
  return written
}

export async function listEntries(
  client = hostedConfigClient(),
  destination: ConfigDestination = {},
) {
  return client.listEntries(HOSTED_CONFIG_ENVIRONMENT, destination)
}

export async function deleteEntry(
  key: string,
  scope: ConfigScope,
  expectedRowVersion: number | undefined,
  client: ConfigClient,
  destination: WriteDestination,
) {
  const version = expectedRowVersion ?? (await getEntry(key, scope, client, destination)).rowVersion
  return client.deleteEntry(
    key,
    {
      scope,
      environment: HOSTED_CONFIG_ENVIRONMENT,
      expectedRowVersion: version,
    },
    destination,
  )
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

export async function listSecrets(
  client = hostedConfigClient(),
  env: ConfigEnvironment = process.env,
) {
  return client.listSecrets(HOSTED_CONFIG_ENVIRONMENT, await pinnedConfigDestination(client, env))
}
