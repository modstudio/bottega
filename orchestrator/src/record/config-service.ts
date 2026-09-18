// concern: record-config
/** Owns tenant-bound hosted config, ciphertext, DEK, wrap, and machine-key operations. */
import { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'

export type ConfigScope = 'user' | 'space'
export type ConfigTenant = { url: string } & TenantPrincipal
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
export type ConfigSecretMetadata = {
  key: string
  environment: string
  scope: ConfigScope
  dekId: string
  rowVersion: number
  updatedAt: string
}
export type ConfigSecret = ConfigSecretMetadata & { envelope: Uint8Array }
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
}

export class ConfigServiceError extends Error {
  status: 404 | 409 | 422
  constructor(message: string, status: 404 | 409 | 422) {
    super(message)
    this.status = status
  }
}

const iso = (value: unknown) => new Date(String(value)).toISOString()
const nullableIso = (value: unknown) => (value == null ? null : iso(value))
const bytes = (value: unknown) => new Uint8Array(value as ArrayBufferLike)
const rowScope = (row: Record<string, unknown>): ConfigScope =>
  row.user_id == null ? 'space' : 'user'
const scopedUser = (input: ConfigTenant, scope: ConfigScope) =>
  scope === 'user' ? input.userId : null

async function tenant<T>(input: ConfigTenant, operation: (tx: SQL) => Promise<T>): Promise<T> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, input)
      return operation(tx)
    })
  } finally {
    await client.close()
  }
}

function entryRow(row: Record<string, unknown>): ConfigEntry {
  return {
    key: String(row.key),
    environment: String(row.environment),
    scope: rowScope(row),
    value: String(row.value),
    rowVersion: Number(row.row_version),
    updatedAt: iso(row.updated_at),
  }
}

function secretMetadata(row: Record<string, unknown>): ConfigSecretMetadata {
  return {
    key: String(row.key),
    environment: String(row.environment),
    scope: rowScope(row),
    dekId: String(row.dek_id),
    rowVersion: Number(row.row_version),
    updatedAt: iso(row.updated_at),
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

function conflict(kind: 'entry' | 'secret'): never {
  throw new ConfigServiceError(`${kind} row version conflict`, 409)
}

async function scopedRow(
  tx: SQL,
  table: 'config_entry' | 'config_secret',
  input: ConfigTenant,
  key: string,
  environment: string,
  scope: ConfigScope,
): Promise<Record<string, unknown> | undefined> {
  const userId = scopedUser(input, scope)
  const rows = await tx.unsafe(
    `SELECT * FROM ${table}
     WHERE space_id=$1::uuid AND key=$2 AND environment=$3
       AND user_id IS NOT DISTINCT FROM $4::uuid
     FOR UPDATE`,
    [input.spaceId, key, environment, userId],
  )
  return rows[0] as Record<string, unknown> | undefined
}

export async function listConfigEntries(
  input: ConfigTenant & { environment?: string },
): Promise<ConfigEntry[]> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT key, environment, user_id, value, row_version, updated_at
      FROM config_entry
      WHERE space_id=${input.spaceId}::uuid
        AND (${input.environment ?? null}::text IS NULL OR environment=${input.environment ?? null})
      ORDER BY key, environment, user_id NULLS FIRST
    `
    return rows.map((row: Record<string, unknown>) => entryRow(row))
  })
}

export async function getConfigEntry(
  input: ConfigTenant & { key: string; environment: string; scope: ConfigScope },
): Promise<ConfigEntry | null> {
  return tenant(input, async (tx) => {
    const row = await scopedRow(
      tx,
      'config_entry',
      input,
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
  return tenant(input, async (tx) => {
    const existing = await scopedRow(
      tx,
      'config_entry',
      input,
      input.key,
      input.environment,
      input.scope,
    )
    if (input.expectedRowVersion === null) {
      if (existing) conflict('entry')
      const rows = await tx`
        INSERT INTO config_entry
          (id, space_id, user_id, key, environment, value, row_version, updated_at)
        VALUES
          (${newRecordId()}::uuid, ${input.spaceId}::uuid, ${scopedUser(input, input.scope)}::uuid,
           ${input.key}, ${input.environment}, ${input.value}, 1, now())
        RETURNING *
      `
      return entryRow(rows[0] as Record<string, unknown>)
    }
    if (!existing) throw new ConfigServiceError('config entry not found', 404)
    if (Number(existing.row_version) !== input.expectedRowVersion) conflict('entry')
    const rows = await tx`
      UPDATE config_entry SET value=${input.value}, row_version=row_version + 1, updated_at=now()
      WHERE id=${String(existing.id)}::uuid
      RETURNING *
    `
    return entryRow(rows[0] as Record<string, unknown>)
  })
}

export async function deleteConfigEntry(
  input: ConfigTenant & {
    key: string
    environment: string
    scope: ConfigScope
    expectedRowVersion: number
  },
): Promise<void> {
  return tenant(input, async (tx) => {
    const existing = await scopedRow(
      tx,
      'config_entry',
      input,
      input.key,
      input.environment,
      input.scope,
    )
    if (!existing) throw new ConfigServiceError('config entry not found', 404)
    if (Number(existing.row_version) !== input.expectedRowVersion) conflict('entry')
    await tx`DELETE FROM config_entry WHERE id=${String(existing.id)}::uuid`
  })
}

export async function listConfigSecrets(
  input: ConfigTenant & { environment?: string },
): Promise<ConfigSecretMetadata[]> {
  return tenant(input, async (tx) => {
    // Deliberately enumerate metadata columns: an envelope must never reach this surface.
    const rows = await tx`
      SELECT key, environment, user_id, dek_id, row_version, updated_at
      FROM config_secret
      WHERE space_id=${input.spaceId}::uuid
        AND (${input.environment ?? null}::text IS NULL OR environment=${input.environment ?? null})
      ORDER BY key, environment, user_id NULLS FIRST
    `
    return rows.map((row: Record<string, unknown>) => secretMetadata(row))
  })
}

export async function getConfigSecret(
  input: ConfigTenant & { key: string; environment: string; scope: ConfigScope },
): Promise<ConfigSecret | null> {
  return tenant(input, async (tx) => {
    const row = await scopedRow(
      tx,
      'config_secret',
      input,
      input.key,
      input.environment,
      input.scope,
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
  },
): Promise<ConfigSecretMetadata> {
  return tenant(input, async (tx) => {
    const deks = await tx`
      SELECT id FROM secret_dek
      WHERE space_id=${input.spaceId}::uuid AND id=${input.dekId}::uuid AND retired_at IS NULL
    `
    if (!deks[0]) throw new ConfigServiceError('data key is absent or retired', 422)
    const existing = await scopedRow(
      tx,
      'config_secret',
      input,
      input.key,
      input.environment,
      input.scope,
    )
    if (input.expectedRowVersion === null) {
      if (existing) conflict('secret')
      const rows = await tx`
        INSERT INTO config_secret
          (id, space_id, user_id, key, environment, dek_id, row_version, envelope, updated_at)
        VALUES
          (${newRecordId()}::uuid, ${input.spaceId}::uuid, ${scopedUser(input, input.scope)}::uuid,
           ${input.key}, ${input.environment}, ${input.dekId}::uuid, 1, ${input.envelope}, now())
        RETURNING key, environment, user_id, dek_id, row_version, updated_at
      `
      return secretMetadata(rows[0] as Record<string, unknown>)
    }
    if (!existing) throw new ConfigServiceError('config secret not found', 404)
    if (Number(existing.row_version) !== input.expectedRowVersion) conflict('secret')
    const rows = await tx`
      UPDATE config_secret
      SET dek_id=${input.dekId}::uuid, envelope=${input.envelope},
          row_version=row_version + 1, updated_at=now()
      WHERE id=${String(existing.id)}::uuid
      RETURNING key, environment, user_id, dek_id, row_version, updated_at
    `
    return secretMetadata(rows[0] as Record<string, unknown>)
  })
}

export async function deleteConfigSecret(
  input: ConfigTenant & {
    key: string
    environment: string
    scope: ConfigScope
    expectedRowVersion: number
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
    )
    if (!existing) throw new ConfigServiceError('config secret not found', 404)
    if (Number(existing.row_version) !== input.expectedRowVersion) conflict('secret')
    await tx`DELETE FROM config_secret WHERE id=${String(existing.id)}::uuid`
  })
}

/** Returns the current DEK and only wraps addressed to the query's recipientKeyId. */
export async function currentDataKey(
  input: ConfigTenant & { recipientKeyId: string },
): Promise<DataKey | null> {
  return tenant(input, async (tx) => {
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
      createdAt: iso(row.created_at),
      retiredAt: nullableIso(row.retired_at),
      wraps: wraps.map((item: Record<string, unknown>) => wrapRow(item)),
    }
  })
}

async function insertWraps(
  tx: SQL,
  input: { spaceId: string; dekId: string; wraps: ConfigWrapInput[] },
): Promise<void> {
  for (const wrap of input.wraps) {
    await tx`
      INSERT INTO secret_dek_wrap
        (space_id, dek_id, recipient_key_id, sender_key_id, enc, ciphertext, created_at)
      VALUES
        (${input.spaceId}::uuid, ${input.dekId}::uuid, ${wrap.recipientKeyId},
         ${wrap.senderKeyId}, ${wrap.enc}, ${wrap.ciphertext}, now())
    `
  }
}

export async function createDataKey(
  input: ConfigTenant & { version: number; wraps: ConfigWrapInput[] },
): Promise<{ id: string; version: number }> {
  return tenant(input, async (tx) => {
    const versions = await tx`
      SELECT version FROM secret_dek WHERE space_id=${input.spaceId}::uuid
      ORDER BY version DESC FOR UPDATE
    `
    const current = versions[0] ? Number(versions[0].version) : 0
    if (input.version !== current + 1) {
      throw new ConfigServiceError(`data key version must be ${current + 1}`, 409)
    }
    const id = newRecordId()
    await tx`
      INSERT INTO secret_dek (id, space_id, version, created_at)
      VALUES (${id}::uuid, ${input.spaceId}::uuid, ${input.version}, now())
    `
    await insertWraps(tx, { spaceId: input.spaceId, dekId: id, wraps: input.wraps })
    return { id, version: input.version }
  })
}

export async function addDataKeyWraps(
  input: ConfigTenant & { dekId: string; wraps: ConfigWrapInput[] },
): Promise<void> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT id FROM secret_dek WHERE space_id=${input.spaceId}::uuid AND id=${input.dekId}::uuid
    `
    if (!rows[0]) throw new ConfigServiceError('data key not found', 404)
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
    if (!rows[0]) throw new ConfigServiceError('data key not found', 404)
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
      SELECT key_id, public_key, label, created_at, revoked_at
      FROM machine_public_key WHERE space_id=${input.spaceId}::uuid
      ORDER BY created_at, key_id
    `
    return rows.map((row: Record<string, unknown>) => ({
      keyId: String(row.key_id),
      publicKey: bytes(row.public_key),
      label: String(row.label),
      createdAt: iso(row.created_at),
      revokedAt: nullableIso(row.revoked_at),
    }))
  })
}

export async function machineKeyId(publicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(publicKey)))
  return Buffer.from(digest.subarray(0, 16)).toString('base64url')
}

export async function registerMachineKey(
  input: ConfigTenant & { keyId: string; publicKey: Uint8Array; label: string },
): Promise<MachineKey> {
  const derived = await machineKeyId(input.publicKey)
  if (derived !== input.keyId) {
    throw new ConfigServiceError('machine key id does not match public key', 422)
  }
  return tenant(input, async (tx) => {
    const rows = await tx`
      INSERT INTO machine_public_key (space_id, key_id, public_key, label, created_at)
      VALUES (${input.spaceId}::uuid, ${input.keyId}, ${input.publicKey}, ${input.label}, now())
      RETURNING key_id, public_key, label, created_at, revoked_at
    `
    const row = rows[0] as Record<string, unknown>
    return {
      keyId: String(row.key_id),
      publicKey: bytes(row.public_key),
      label: String(row.label),
      createdAt: iso(row.created_at),
      revokedAt: nullableIso(row.revoked_at),
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
    if (!rows[0]) throw new ConfigServiceError('machine key not found', 404)
    await tx`
      DELETE FROM secret_dek_wrap
      WHERE space_id=${input.spaceId}::uuid AND recipient_key_id=${input.keyId}
    `
  })
}
