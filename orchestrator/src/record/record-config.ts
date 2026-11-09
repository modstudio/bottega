// concern: record-config
/** Owns tenant-bound hosted config, ciphertext, DEK, wrap, and machine-key operations. */

import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { machineKeyId } from '../../../shared/machine-key-id.ts'
import { resolvePersonalItemSpace } from '../../../shared/personal-item-space.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { configAccessRemedy } from '../../../shared/record-remedies.ts'
import { recordDate, recordIso } from '../../../shared/record-timestamp.ts'
import {
  generateMachineKeyPair,
  KEY_SIZE,
  sealClaimChallenge,
} from '../../../shared/secret-envelope.ts'
import { assertConfigAccessRemovalSafe } from './record-config-access-removal.ts'
import { ConfigServiceError, isUniqueViolation } from './record-config-error.ts'
import { recordPool } from './record-pool.ts'

export const CONFIG_SCOPES = ['user', 'space'] as const
export type ConfigScope = (typeof CONFIG_SCOPES)[number]
export type ConfigTenant = { url: string; personalSpaceId?: string | null } & TenantPrincipal
export type ConfigWrapInput = {
  recipientKeyId: string
  senderKeyId: string
  enc: Uint8Array
  ciphertext: Uint8Array
}
export type ConfigEntry = {
  key: string
  environment: string
  scope: ConfigScope
  value: string
  rowVersion: number
  updatedAt: string
}

import {
  type ConfigSecret,
  type ConfigSecretMetadata,
  secretMetadata,
} from './record-credential-secret.ts'

export type { ConfigSecret, ConfigSecretMetadata } from './record-credential-secret.ts'

type DataKeyWrap = ConfigWrapInput
export type DataKey = {
  id: string
  version: number
  createdAt: string
  retiredAt: string | null
  wraps: DataKeyWrap[]
}
export type MachineKey = {
  keyId: string
  publicKey: Uint8Array
  label: string
  createdAt: string
  revokedAt: string | null
  userId: string | null
}
export type MachineKeyClaimChallenge = {
  challengeId: string
  enc: Uint8Array
  ciphertext: Uint8Array
  senderPublicKey: Uint8Array
}
const MACHINE_KEY_CLAIM_TTL_MS = 5 * 60 * 1000

const nullableIso = (value: unknown) => (value == null ? null : recordIso(value))
const bytes = (value: unknown) => new Uint8Array(value as ArrayBufferLike)
const rowScope = (row: Record<string, unknown>): ConfigScope =>
  row.user_id == null ? 'space' : 'user'
const scopedUser = (input: ConfigTenant, scope: ConfigScope) =>
  scope === 'user' ? input.userId : null

function configTenant(input: ConfigTenant, scope: ConfigScope): ConfigTenant {
  const spaceId = resolvePersonalItemSpace(
    {
      userId: input.userId,
      activeSpaceId: input.spaceId,
      personalSpaceId: input.personalSpaceId ?? null,
    },
    { kind: 'config-entry', scope },
  )
  if (!spaceId) throw new ConfigServiceError('personal space is not provisioned', 409)
  return { ...input, spaceId, spaceIds: [spaceId] }
}

export async function tenant<T>(
  input: ConfigTenant,
  operation: (tx: SQL) => Promise<T>,
): Promise<T> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    return operation(tx)
  })
}

function entryRow(row: Record<string, unknown>): ConfigEntry {
  return {
    key: String(row.key),
    environment: String(row.environment),
    scope: rowScope(row),
    value: String(row.value),
    rowVersion: Number(row.row_version),
    updatedAt: recordIso(row.updated_at),
  }
}

function wrapRow(row: Record<string, unknown>): DataKeyWrap {
  return {
    recipientKeyId: String(row.recipient_key_id),
    senderKeyId: String(row.sender_key_id),
    enc: bytes(row.enc),
    ciphertext: bytes(row.ciphertext),
  }
}

const withdrawnConfigAccessRemedy = `ask a space owner or admin to grant config access, run \`${PLATFORM_SLUG} machine config machine init\` to replace the revoked key, then trust the new key from a machine that holds config access with \`${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey>\``
const machineClaimRemedy = `run \`${PLATFORM_SLUG} machine config machine init\` on that machine`

function revokedMachineRefusal(condition: string): ConfigServiceError {
  return new ConfigServiceError(`${condition}; ${withdrawnConfigAccessRemedy}`, 422)
}

export async function requireConfigAccess(tx: SQL, input: ConfigTenant): Promise<void> {
  const rows = await tx`
    SELECT config_access FROM membership
    WHERE space_id=${input.spaceId}::uuid AND user_id=${input.userId}::uuid
  `
  if (rows[0]?.config_access === true) return
  const revoked = await tx`
    SELECT 1 FROM machine_public_key
    WHERE space_id=${input.spaceId}::uuid AND user_id=${input.userId}::uuid
      AND revoked_at IS NOT NULL
    LIMIT 1
  `
  if (revoked[0])
    throw revokedMachineRefusal(
      'signed-in user lacks config access and a machine key of this user in the space is revoked',
    )
  throw new ConfigServiceError(configAccessRemedy(), 422)
}

async function refuseRevokedRecipient(
  tx: SQL,
  input: ConfigTenant & { recipientKeyId: string },
): Promise<void> {
  const revoked = await tx`
    SELECT 1 FROM machine_public_key
    WHERE space_id=${input.spaceId}::uuid AND key_id=${input.recipientKeyId}
      AND revoked_at IS NOT NULL
    LIMIT 1
  `
  if (revoked[0]) throw revokedMachineRefusal("this machine's key is revoked in the space")
}

function conflict(kind: 'entry' | 'secret', currentRowVersion: number): never {
  throw new ConfigServiceError(
    `config ${kind} row version conflict: current rowVersion is ${currentRowVersion}; GET the config ${kind}, then retry with expectedRowVersion ${currentRowVersion}`,
    409,
  )
}

type Occupancy =
  | { action: 'create' }
  | { action: 'update'; existing: Record<string, unknown> }
  | { action: 'not-found' }
  | { action: 'conflict'; currentRowVersion: number }

function configOccupancy(input: {
  existing: Record<string, unknown> | undefined
  expectedRowVersion: number | null
}): Occupancy {
  if (!input.existing) {
    return input.expectedRowVersion === null ? { action: 'create' } : { action: 'not-found' }
  }
  const currentRowVersion = Number(input.existing.row_version)
  if (input.expectedRowVersion === null || input.expectedRowVersion !== currentRowVersion) {
    return { action: 'conflict', currentRowVersion }
  }
  return { action: 'update', existing: input.existing }
}

function notFound(kind: 'entry' | 'secret'): never {
  throw new ConfigServiceError(
    `config ${kind} not found; PUT with expectedRowVersion null to create it`,
    404,
  )
}

function applyOccupancy(kind: 'entry' | 'secret', occupancy: Occupancy): void {
  if (occupancy.action === 'not-found') notFound(kind)
  if (occupancy.action === 'conflict') conflict(kind, occupancy.currentRowVersion)
}

class ConcurrentConfigCreate extends Error {}
class ConcurrentDataKeyCreate extends Error {}

async function scopedRow(
  tx: SQL,
  table: 'config_entry' | 'config_secret',
  input: ConfigTenant,
  key: string,
  environment: string,
  scope: ConfigScope,
  lock = false,
  projectId?: string | null,
): Promise<Record<string, unknown> | undefined> {
  const userId = scopedUser(input, scope)
  const rows = await tx.unsafe(
    `SELECT * FROM ${table}
     WHERE space_id=$1::uuid AND key=$2 AND environment=$3
       AND user_id IS NOT DISTINCT FROM $4::uuid${table === 'config_secret' ? '\n       AND project_id IS NOT DISTINCT FROM $5::uuid' : ''}${lock ? '\n     FOR UPDATE' : ''}`,
    table === 'config_secret'
      ? [input.spaceId, key, environment, userId, projectId ?? null]
      : [input.spaceId, key, environment, userId],
  )
  return rows[0] as Record<string, unknown> | undefined
}

export async function listConfigEntries(
  input: ConfigTenant & { environment?: string },
): Promise<ConfigEntry[]> {
  // A missing personal space hides only the caller's own entries, never the space's.
  const personalSpaceId = input.personalSpaceId ?? null
  const spaces = [...new Set([input.spaceId, personalSpaceId].filter((id) => id !== null))]
  return tenant({ ...input, spaceIds: spaces }, async (tx) => {
    const rows = await tx`
      SELECT key, environment, user_id, value, row_version, updated_at
      FROM config_entry
      WHERE ((space_id=${input.spaceId}::uuid AND user_id IS NULL)
          OR (space_id=${personalSpaceId}::uuid AND user_id=${input.userId}::uuid))
        AND (${input.environment ?? null}::text IS NULL OR environment=${input.environment ?? null})
      ORDER BY key, environment, user_id NULLS FIRST
    `
    return rows.map((row: Record<string, unknown>) => entryRow(row))
  })
}

export async function getConfigEntry(
  input: ConfigTenant & {
    key: string
    environment: string
    scope: ConfigScope
  },
): Promise<ConfigEntry | null> {
  const resolved = configTenant(input, input.scope)
  return tenant(resolved, async (tx) => {
    const row = await scopedRow(
      tx,
      'config_entry',
      resolved,
      input.key,
      input.environment,
      input.scope,
    )
    return row ? entryRow(row) : null
  })
}

export async function putConfigEntry(
  input: ConfigTenant & {
    key: string
    environment: string
    scope: ConfigScope
    value: string
    expectedRowVersion: number | null
  },
): Promise<ConfigEntry> {
  const resolved = configTenant(input, input.scope)
  try {
    return await tenant(resolved, async (tx) => {
      const existing = await scopedRow(
        tx,
        'config_entry',
        resolved,
        input.key,
        input.environment,
        input.scope,
        true,
      )
      const occupancy = configOccupancy({
        existing,
        expectedRowVersion: input.expectedRowVersion,
      })
      applyOccupancy('entry', occupancy)
      if (occupancy.action === 'create') {
        try {
          const rows = await tx`
          INSERT INTO config_entry
            (id, space_id, user_id, key, environment, value, row_version, updated_at)
          VALUES
            (${newRecordId()}::uuid, ${resolved.spaceId}::uuid, ${scopedUser(resolved, input.scope)}::uuid,
             ${input.key}, ${input.environment}, ${input.value}, 1, now())
          RETURNING *
        `
          return entryRow(rows[0] as Record<string, unknown>)
        } catch (error) {
          if (isUniqueViolation(error, 'config_entry_scope_unique')) {
            throw new ConcurrentConfigCreate()
          }
          throw error
        }
      }
      if (occupancy.action !== 'update') throw new Error('unreachable config entry put action')
      const rows = await tx`
      UPDATE config_entry SET value=${input.value}, row_version=row_version + 1, updated_at=now()
      WHERE id=${String(occupancy.existing.id)}::uuid
      RETURNING *
    `
      return entryRow(rows[0] as Record<string, unknown>)
    })
  } catch (error) {
    if (!(error instanceof ConcurrentConfigCreate)) throw error
    const current = await getConfigEntry(input)
    conflict('entry', current?.rowVersion ?? 1)
  }
}

export async function deleteConfigEntry(
  input: ConfigTenant & {
    key: string
    environment: string
    scope: ConfigScope
    expectedRowVersion: number
  },
): Promise<void> {
  const resolved = configTenant(input, input.scope)
  return tenant(resolved, async (tx) => {
    const existing = await scopedRow(
      tx,
      'config_entry',
      resolved,
      input.key,
      input.environment,
      input.scope,
      true,
    )
    const occupancy = configOccupancy({
      existing,
      expectedRowVersion: input.expectedRowVersion,
    })
    applyOccupancy('entry', occupancy)
    if (occupancy.action !== 'update') throw new Error('unreachable config entry delete action')
    await tx`DELETE FROM config_entry WHERE id=${String(occupancy.existing.id)}::uuid`
  })
}

export async function listConfigSecrets(
  input: ConfigTenant & { environment?: string },
): Promise<ConfigSecretMetadata[]> {
  return tenant(input, async (tx) => {
    // Deliberately enumerate metadata columns: an envelope must never reach this surface.
    const rows = await tx`
      SELECT id, key, environment, user_id, project_id, provider, name, type, hint, mode, reach_space_ids,
        dek_id, row_version, updated_at
      FROM config_secret
      WHERE space_id=${input.spaceId}::uuid
        AND (${input.environment ?? null}::text IS NULL OR environment=${input.environment ?? null})
      ORDER BY key, environment, user_id NULLS FIRST
    `
    return rows.map((row: Record<string, unknown>) => secretMetadata(row))
  })
}

export async function getConfigSecret(
  input: ConfigTenant & {
    key: string
    environment: string
    scope: ConfigScope
    projectId?: string | null
  },
): Promise<ConfigSecret | null> {
  return tenant(input, async (tx) => {
    const row = await scopedRow(
      tx,
      'config_secret',
      input,
      input.key,
      input.environment,
      input.scope,
      false,
      input.projectId,
    )
    return row ? { ...secretMetadata(row), envelope: bytes(row.envelope) } : null
  })
}

/**
 * Stores opaque ciphertext only. The caller must seal the envelope for the NEW row version:
 * expectedRowVersion + 1 for an update, or 1 for a create, because AAD binds row_version.
 */
export async function putConfigSecret(
  input: ConfigTenant & {
    key: string
    environment: string
    scope: ConfigScope
    dekId: string
    envelope: Uint8Array
    expectedRowVersion: number | null
    projectId?: string | null
    provider?: string | null
    name?: string | null
    type?: string | null
    hint?: string | null
    mode?: string | null
    reachSpaceIds?: string[] | null
  },
): Promise<ConfigSecretMetadata> {
  const invalidReach =
    input.reachSpaceIds != null &&
    (input.scope !== 'user' || input.projectId != null || input.spaceId !== input.personalSpaceId)
  if (invalidReach)
    throw new ConfigServiceError(
      `credential reach is only valid for a user credential in the personal space; use \`${PLATFORM_SLUG} credential set ${input.key.split('#')[0]} --account --reach all\``,
      422,
    )
  try {
    return await tenant(input, async (tx) => {
      const deks = await tx`
      SELECT id FROM secret_dek
      WHERE space_id=${input.spaceId}::uuid AND id=${input.dekId}::uuid AND retired_at IS NULL
    `
      if (!deks[0]) {
        throw new ConfigServiceError(
          'data key is absent or retired; GET /v1/config/data-keys/current or POST /v1/config/data-keys',
          422,
        )
      }
      if (input.projectId) {
        const projects =
          await tx`SELECT 1 FROM project WHERE id=${input.projectId}::uuid AND space_id=${input.spaceId}::uuid`
        if (!projects[0])
          throw new ConfigServiceError('credential project is not in the destination space', 422)
      }
      const existing = await scopedRow(
        tx,
        'config_secret',
        input,
        input.key,
        input.environment,
        input.scope,
        true,
        input.projectId,
      )
      const occupancy = configOccupancy({
        existing,
        expectedRowVersion: input.expectedRowVersion,
      })
      applyOccupancy('secret', occupancy)
      if (occupancy.action === 'create') {
        try {
          const rows = await tx`
          INSERT INTO config_secret
            (id, space_id, user_id, project_id, key, provider, name, type, mode, environment, hint, reach_space_ids,
             dek_id, row_version, envelope, updated_at)
          VALUES
            (${newRecordId()}::uuid, ${input.spaceId}::uuid, ${scopedUser(input, input.scope)}::uuid,
             ${input.projectId ?? null}::uuid, ${input.key}, ${input.provider ?? null},
             ${input.name ?? null}, ${input.type ?? null}, ${input.mode ?? null}, ${input.environment}, ${input.hint ?? null}, ${input.reachSpaceIds === null || input.reachSpaceIds === undefined ? null : tx.array(input.reachSpaceIds, 'uuid')},
             ${input.dekId}::uuid, 1, ${input.envelope}, now())
          RETURNING id, key, environment, user_id, project_id, provider, name, type, hint, mode, reach_space_ids,
            dek_id, row_version, updated_at
        `
          return secretMetadata(rows[0] as Record<string, unknown>)
        } catch (error) {
          if (isUniqueViolation(error, 'config_secret_scope_unique')) {
            throw new ConcurrentConfigCreate()
          }
          throw error
        }
      }
      if (occupancy.action !== 'update') throw new Error('unreachable config secret put action')
      const rows = await tx`
      UPDATE config_secret
      SET dek_id=${input.dekId}::uuid, envelope=${input.envelope},
          project_id=${input.projectId ?? null}::uuid, provider=${input.provider ?? null},
          name=${input.name ?? null}, type=${input.type ?? null}, hint=${input.hint ?? null}, mode=${input.mode ?? null},
          reach_space_ids=${input.reachSpaceIds === null || input.reachSpaceIds === undefined ? null : tx.array(input.reachSpaceIds, 'uuid')},
          row_version=row_version + 1, updated_at=now()
      WHERE id=${String(occupancy.existing.id)}::uuid
      RETURNING id, key, environment, user_id, project_id, provider, name, type, hint, mode, reach_space_ids,
        dek_id, row_version, updated_at
    `
      return secretMetadata(rows[0] as Record<string, unknown>)
    })
  } catch (error) {
    if (!(error instanceof ConcurrentConfigCreate)) throw error
    const current = await getConfigSecret(input)
    conflict('secret', current?.rowVersion ?? 1)
  }
}

export async function deleteConfigSecret(
  input: ConfigTenant & {
    key: string
    environment: string
    scope: ConfigScope
    expectedRowVersion: number
    projectId?: string | null
  },
): Promise<void> {
  return tenant(input, async (tx) => {
    const existing = await scopedRow(
      tx,
      'config_secret',
      input,
      input.key,
      input.environment,
      input.scope,
      true,
      input.projectId,
    )
    const occupancy = configOccupancy({
      existing,
      expectedRowVersion: input.expectedRowVersion,
    })
    applyOccupancy('secret', occupancy)
    if (occupancy.action !== 'update') throw new Error('unreachable config secret delete action')
    await tx`DELETE FROM config_secret WHERE id=${String(occupancy.existing.id)}::uuid`
  })
}

/** Returns the current DEK and only wraps addressed to the query's recipientKeyId. */
export async function currentDataKey(
  input: ConfigTenant & { recipientKeyId: string },
): Promise<DataKey | null> {
  return tenant(input, async (tx) => {
    await refuseRevokedRecipient(tx, input)
    await requireConfigAccess(tx, input)
    const rows = await tx`
      SELECT * FROM secret_dek
      WHERE space_id=${input.spaceId}::uuid AND retired_at IS NULL
      ORDER BY version DESC LIMIT 1
    `
    if (!rows[0]) return null
    const row = rows[0] as Record<string, unknown>
    const wraps = await tx`
      SELECT recipient_key_id, sender_key_id, enc, ciphertext
      FROM secret_dek_wrap
      WHERE space_id=${input.spaceId}::uuid AND dek_id=${String(row.id)}::uuid
        AND recipient_key_id=${input.recipientKeyId}
      ORDER BY sender_key_id
    `
    return {
      id: String(row.id),
      version: Number(row.version),
      createdAt: recordIso(row.created_at),
      retiredAt: nullableIso(row.retired_at),
      wraps: wraps.map((item: Record<string, unknown>) => wrapRow(item)),
    }
  })
}

/** Returns one DEK and only wraps addressed to the requesting machine. */
export async function getDataKey(
  input: ConfigTenant & { dekId: string; recipientKeyId: string },
): Promise<DataKey | null> {
  return tenant(input, async (tx) => {
    await refuseRevokedRecipient(tx, input)
    await requireConfigAccess(tx, input)
    const rows = await tx`
      SELECT * FROM secret_dek
      WHERE space_id=${input.spaceId}::uuid AND id=${input.dekId}::uuid
    `
    if (!rows[0]) return null
    const row = rows[0] as Record<string, unknown>
    const wraps = await tx`
      SELECT recipient_key_id, sender_key_id, enc, ciphertext
      FROM secret_dek_wrap
      WHERE space_id=${input.spaceId}::uuid AND dek_id=${input.dekId}::uuid
        AND recipient_key_id=${input.recipientKeyId}
      ORDER BY sender_key_id
    `
    return {
      id: String(row.id),
      version: Number(row.version),
      createdAt: recordIso(row.created_at),
      retiredAt: nullableIso(row.retired_at),
      wraps: wraps.map((item: Record<string, unknown>) => wrapRow(item)),
    }
  })
}

export async function listDataKeys(input: ConfigTenant): Promise<DataKey[]> {
  return tenant(input, async (tx) => {
    await requireConfigAccess(tx, input)
    const rows = await tx`
      SELECT * FROM secret_dek
      WHERE space_id=${input.spaceId}::uuid
      ORDER BY version
    `
    return rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      version: Number(row.version),
      createdAt: recordIso(row.created_at),
      retiredAt: nullableIso(row.retired_at),
      wraps: [],
    }))
  })
}

async function validateWrapKeys(
  tx: SQL,
  input: { spaceId: string; wraps: ConfigWrapInput[] },
): Promise<void> {
  const active = new Set<string>()
  for (const keyId of new Set(input.wraps.map((wrap) => wrap.recipientKeyId))) {
    const rows = await tx`
      SELECT k.key_id, k.user_id, m.config_access
      FROM machine_public_key k
      LEFT JOIN membership m ON m.space_id=k.space_id AND m.user_id=k.user_id
      WHERE k.space_id=${input.spaceId}::uuid AND k.key_id=${keyId} AND k.revoked_at IS NULL
      FOR UPDATE OF k
    `
    const row = rows[0]
    if (!row) continue
    assertWrapRecipientAccess(keyId, row.user_id, row.config_access)
    active.add(keyId)
  }
  assertActiveWrapRecipients(input.wraps, active)

  const registered = new Set<string>()
  for (const keyId of new Set(input.wraps.map((wrap) => wrap.senderKeyId))) {
    const rows = await tx`
      SELECT key_id FROM machine_public_key
      WHERE space_id=${input.spaceId}::uuid AND key_id=${keyId}
      FOR UPDATE
    `
    if (rows[0]) registered.add(keyId)
  }
  assertRegisteredWrapSenders(input.wraps, registered)
}

export function assertWrapRecipientAccess(
  keyId: string,
  userId: unknown,
  configAccess: unknown,
): void {
  if (userId == null)
    throw new ConfigServiceError(
      `wrap recipient ${keyId} has no owning user; ${machineClaimRemedy}`,
      422,
    )
  if (configAccess !== true)
    throw new ConfigServiceError(
      `wrap recipient ${keyId} belongs to a user without config access; ${configAccessRemedy()}`,
      422,
    )
}

export function assertActiveWrapRecipients(
  wraps: ConfigWrapInput[],
  activeKeyIds: ReadonlySet<string>,
): void {
  const invalid = wraps.find((wrap) => !activeKeyIds.has(wrap.recipientKeyId))
  if (invalid)
    throw new ConfigServiceError(
      `wrap recipient ${invalid.recipientKeyId} is not a registered non-revoked machine in this space; list machine keys and retry with an active recipient`,
      422,
    )
}

export function assertRegisteredWrapSenders(
  wraps: ConfigWrapInput[],
  registeredKeyIds: ReadonlySet<string>,
): void {
  const invalid = wraps.find((wrap) => !registeredKeyIds.has(wrap.senderKeyId))
  if (invalid)
    throw new ConfigServiceError(
      `wrap sender ${invalid.senderKeyId} is not a registered machine in this space; list machine keys and retry with a registered sender`,
      422,
    )
}

async function insertWraps(
  tx: SQL,
  input: { spaceId: string; dekId: string; wraps: ConfigWrapInput[] },
): Promise<void> {
  for (const wrap of input.wraps) {
    await tx`
      INSERT INTO secret_dek_wrap
        (id, space_id, dek_id, recipient_key_id, sender_key_id, enc, ciphertext, created_at)
      VALUES
        (${newRecordId()}::uuid, ${input.spaceId}::uuid, ${input.dekId}::uuid, ${wrap.recipientKeyId},
         ${wrap.senderKeyId}, ${wrap.enc}, ${wrap.ciphertext}, now())
    `
  }
}

export async function createDataKey(
  input: ConfigTenant & { dekId: string; version: number; wraps: ConfigWrapInput[] },
): Promise<{ id: string; version: number }> {
  try {
    return await tenant(input, async (tx) => {
      const versions = await tx`
      SELECT version FROM secret_dek WHERE space_id=${input.spaceId}::uuid
      ORDER BY version DESC FOR UPDATE
    `
      const current = versions[0] ? Number(versions[0].version) : 0
      if (input.version !== current + 1) {
        throw new ConfigServiceError(
          `data key version must be ${current + 1}; GET /v1/config/data-keys/current, then POST /v1/config/data-keys with that version`,
          409,
        )
      }
      await validateWrapKeys(tx, input)
      try {
        await tx`
        INSERT INTO secret_dek (id, space_id, version, created_at)
        VALUES (${input.dekId}::uuid, ${input.spaceId}::uuid, ${input.version}, now())
      `
      } catch (error) {
        if (isUniqueViolation(error, 'secret_dek_pkey')) {
          throw new ConfigServiceError('data key id is already used', 409)
        }
        if (isUniqueViolation(error, 'secret_dek_space_version_unique')) {
          throw new ConcurrentDataKeyCreate()
        }
        throw error
      }
      await insertWraps(tx, {
        spaceId: input.spaceId,
        dekId: input.dekId,
        wraps: input.wraps,
      })
      return { id: input.dekId, version: input.version }
    })
  } catch (error) {
    if (isUniqueViolation(error, 'secret_dek_pkey')) {
      throw new ConfigServiceError('data key id is already used', 409)
    }
    const concurrentVersion = isUniqueViolation(error, 'secret_dek_space_version_unique')
    if (!(error instanceof ConcurrentDataKeyCreate) && !concurrentVersion) throw error
    const next = await tenant(input, async (tx) => {
      const rows = await tx`
        SELECT version FROM secret_dek WHERE space_id=${input.spaceId}::uuid
        ORDER BY version DESC LIMIT 1
      `
      return (rows[0] ? Number(rows[0].version) : 0) + 1
    })
    throw new ConfigServiceError(
      `data key version must be ${next}; GET /v1/config/data-keys/current, then POST /v1/config/data-keys with that version`,
      409,
    )
  }
}

export async function addDataKeyWraps(
  input: ConfigTenant & { dekId: string; wraps: ConfigWrapInput[] },
): Promise<void> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT id FROM secret_dek WHERE space_id=${input.spaceId}::uuid AND id=${input.dekId}::uuid
    `
    if (!rows[0]) {
      throw new ConfigServiceError(
        'data key not found; GET /v1/config/data-keys/current or POST /v1/config/data-keys',
        404,
      )
    }
    await validateWrapKeys(tx, input)
    await insertWraps(tx, input)
  })
}

export async function retireDataKey(input: ConfigTenant & { dekId: string }): Promise<void> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      UPDATE secret_dek SET retired_at=COALESCE(retired_at, now())
      WHERE space_id=${input.spaceId}::uuid AND id=${input.dekId}::uuid
      RETURNING id
    `
    if (!rows[0]) {
      throw new ConfigServiceError(
        'data key not found; GET /v1/config/data-keys/current or POST /v1/config/data-keys',
        404,
      )
    }
  })
}

export async function deleteDataKeyWraps(
  input: ConfigTenant & { recipientKeyId: string },
): Promise<void> {
  return tenant(input, async (tx) => {
    await tx`
      DELETE FROM secret_dek_wrap
      WHERE space_id=${input.spaceId}::uuid AND recipient_key_id=${input.recipientKeyId}
    `
  })
}

export async function listMachineKeys(input: ConfigTenant): Promise<MachineKey[]> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT key_id, public_key, label, created_at, revoked_at, user_id
      FROM machine_public_key WHERE space_id=${input.spaceId}::uuid
      ORDER BY created_at, key_id
    `
    return rows.map((row: Record<string, unknown>) => ({
      keyId: String(row.key_id),
      publicKey: bytes(row.public_key),
      label: String(row.label),
      createdAt: recordIso(row.created_at),
      revokedAt: nullableIso(row.revoked_at),
      userId: row.user_id == null ? null : String(row.user_id),
    }))
  })
}

export async function registerMachineKey(
  input: ConfigTenant & { keyId: string; publicKey: Uint8Array; label: string },
): Promise<MachineKey> {
  const derived = await machineKeyId(input.publicKey)
  if (derived !== input.keyId) {
    throw new ConfigServiceError(
      'machine key id does not match public key; derive it as the first 16 bytes of SHA-256(publicKey), encoded as unpadded base64url',
      422,
    )
  }
  return tenant(input, async (tx) => {
    const rows = await tx`
      INSERT INTO machine_public_key (id, space_id, user_id, key_id, public_key, label, created_at)
      VALUES (${newRecordId()}::uuid, ${input.spaceId}::uuid, ${input.userId}::uuid, ${input.keyId}, ${input.publicKey}, ${input.label}, now())
      ON CONFLICT (space_id, key_id) DO NOTHING
      RETURNING key_id, public_key, label, created_at, revoked_at, user_id
    `
    const existing = rows[0]
      ? rows
      : await tx`
          SELECT key_id, public_key, label, created_at, revoked_at, user_id
          FROM machine_public_key
          WHERE space_id=${input.spaceId}::uuid AND key_id=${input.keyId}
        `
    const row = existing[0] as Record<string, unknown>
    if (!Buffer.from(bytes(row.public_key)).equals(Buffer.from(input.publicKey)))
      throw new ConfigServiceError(
        'machine key id is already registered with a different public key',
        409,
      )
    if (row.user_id != null && String(row.user_id) !== input.userId)
      throw new ConfigServiceError(
        `machine key ${input.keyId} belongs to another user; register from the owning user's machine, or initialize a new key on this machine with \`${PLATFORM_SLUG} machine config machine init\``,
        409,
      )
    return {
      keyId: String(row.key_id),
      publicKey: bytes(row.public_key),
      label: String(row.label),
      createdAt: recordIso(row.created_at),
      revokedAt: nullableIso(row.revoked_at),
      userId: row.user_id == null ? null : String(row.user_id),
    }
  })
}

export async function createMachineKeyClaimChallenge(
  input: ConfigTenant & { keyId: string },
): Promise<MachineKeyClaimChallenge> {
  const sender = await generateMachineKeyPair()
  const nonce = crypto.getRandomValues(new Uint8Array(KEY_SIZE))
  const nonceHash = new Uint8Array(await crypto.subtle.digest('SHA-256', nonce))
  return tenant(input, async (tx) => {
    const keys = await tx`
      SELECT public_key, user_id FROM machine_public_key
      WHERE space_id=${input.spaceId}::uuid AND key_id=${input.keyId} AND revoked_at IS NULL
      FOR UPDATE
    `
    const key = keys[0]
    if (!key)
      throw new ConfigServiceError('machine key not found or revoked; register it, then retry', 404)
    if (key.user_id != null)
      throw new ConfigServiceError(
        'machine key already has an owning user; no claim is needed',
        409,
      )
    const challengeId = newRecordId()
    const sealed = await sealClaimChallenge({
      nonce,
      spaceId: input.spaceId,
      keyId: input.keyId,
      senderPrivateKey: sender.privateKey,
      senderPublicKey: sender.publicKey,
      recipientPublicKey: bytes(key.public_key),
    })
    await tx`
      INSERT INTO machine_key_claim_challenge
        (id, space_id, key_id, user_id, nonce_hash, expires_at, created_at)
      VALUES (${challengeId}::uuid, ${input.spaceId}::uuid, ${input.keyId}, ${input.userId}::uuid,
        ${nonceHash}, now() + (${MACHINE_KEY_CLAIM_TTL_MS} * interval '1 millisecond'), now())
    `
    return { challengeId, ...sealed, senderPublicKey: sender.publicKey }
  })
}

export async function claimMachineKey(
  input: ConfigTenant & { keyId: string; challengeId: string; nonce: Uint8Array },
): Promise<void> {
  const nonceHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', input.nonce as Uint8Array<ArrayBuffer>),
  )
  const result = await tenant(input, async (tx) => {
    const rows = await tx`
      DELETE FROM machine_key_claim_challenge
      WHERE id=${input.challengeId}::uuid
      RETURNING space_id, key_id, user_id, nonce_hash, expires_at
    `
    const challenge = rows[0]
    const matches =
      challenge &&
      String(challenge.space_id) === input.spaceId &&
      String(challenge.key_id) === input.keyId &&
      String(challenge.user_id) === input.userId &&
      recordDate(challenge.expires_at).getTime() > Date.now() &&
      Buffer.from(bytes(challenge.nonce_hash)).equals(Buffer.from(nonceHash))
    if (!matches) return 'invalid' as const
    const claimed = await tx`
      UPDATE machine_public_key SET user_id=${input.userId}::uuid
      WHERE space_id=${input.spaceId}::uuid AND key_id=${input.keyId} AND user_id IS NULL
      RETURNING key_id
    `
    return claimed[0] ? ('claimed' as const) : ('owned' as const)
  })
  if (result === 'invalid')
    throw new ConfigServiceError(
      `machine key claim challenge is invalid or expired; ${machineClaimRemedy}`,
      422,
    )
  if (result === 'owned')
    throw new ConfigServiceError(
      'machine key already has an owning user; initialize a new key',
      409,
    )
}

export type SpaceConfigAccessMember = {
  email: string
  role: string
  permission: string
  configAccess: boolean
}

export async function listSpaceConfigAccess(
  input: ConfigTenant,
): Promise<SpaceConfigAccessMember[]> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT u.email, m.role, m.permission, m.config_access
      FROM membership m JOIN "user" u ON u.id=m.user_id
      WHERE m.space_id=${input.spaceId}::uuid ORDER BY lower(u.email)
    `
    return rows.map((row: Record<string, unknown>) => ({
      email: String(row.email),
      role: String(row.role),
      permission: String(row.permission),
      configAccess: row.config_access === true,
    }))
  })
}

export async function grantSpaceConfigAccess(
  input: ConfigTenant & { email: string },
): Promise<void> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      UPDATE membership m SET config_access=true
      FROM "user" u
      WHERE m.space_id=${input.spaceId}::uuid AND m.user_id=u.id
        AND lower(u.email)=lower(${input.email})
        AND record_membership_admin(m.space_id)
      RETURNING m.id
    `
    if (!rows[0])
      throw new ConfigServiceError(
        'config access grant requires an owner or admin and an email belonging to this space; ask a space owner or admin to retry with a listed member',
        422,
      )
  })
}

export type WithdrawSpaceConfigAccessResult = {
  revokedMachineKeyIds: string[]
  readableSecretKeys: string[]
}

export async function withdrawSpaceConfigAccess(
  input: ConfigTenant & { email: string },
): Promise<WithdrawSpaceConfigAccessResult> {
  return tenant(input, async (tx) => {
    const members = await tx`
      SELECT m.id, m.user_id, m.role, m.config_access
      FROM membership m JOIN "user" u ON u.id=m.user_id
      WHERE m.space_id=${input.spaceId}::uuid
        AND lower(u.email)=lower(${input.email})
        AND record_membership_admin(m.space_id)
      FOR UPDATE OF m
    `
    const member = members[0]
    if (!member)
      throw new ConfigServiceError(
        'config access withdrawal requires an owner or admin and an email belonging to this space; ask a space owner or admin to retry with a listed member',
        422,
      )
    if (String(member.role) === 'owner')
      throw new ConfigServiceError(
        'cannot withdraw config access from an owner because owners hold config access; change their role first',
        422,
      )
    if (member.config_access !== true)
      throw new ConfigServiceError(
        `member ${input.email} does not have config access; list space access and choose a current holder`,
        422,
      )
    await assertConfigAccessRemovalSafe(tx, input.spaceId, String(member.user_id))
    const secrets = await tx`
      SELECT DISTINCT key FROM config_secret
      WHERE space_id=${input.spaceId}::uuid AND user_id IS NULL
      ORDER BY key
    `
    await tx`UPDATE membership SET config_access=false WHERE id=${String(member.id)}::uuid`
    const machines = await tx`
      SELECT key_id FROM machine_public_key
      WHERE space_id=${input.spaceId}::uuid
        AND user_id=${String(member.user_id)}::uuid
        AND revoked_at=now()
      ORDER BY key_id
    `
    return {
      revokedMachineKeyIds: machines.map((row: Record<string, unknown>) => String(row.key_id)),
      readableSecretKeys: secrets.map((row: Record<string, unknown>) => String(row.key)),
    }
  })
}

export async function revokeMachineKey(input: ConfigTenant & { keyId: string }): Promise<void> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      UPDATE machine_public_key SET revoked_at=COALESCE(revoked_at, now())
      WHERE space_id=${input.spaceId}::uuid AND key_id=${input.keyId}
      RETURNING key_id
    `
    if (!rows[0]) {
      throw new ConfigServiceError(
        'machine key not found; GET /v1/config/machine-keys, then retry with a listed keyId',
        404,
      )
    }
    await tx`
      DELETE FROM secret_dek_wrap
      WHERE space_id=${input.spaceId}::uuid AND recipient_key_id=${input.keyId}
    `
  })
}
