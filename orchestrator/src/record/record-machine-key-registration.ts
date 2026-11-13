// concern: record-machine-key-registration
/** Owns hosted machine-key listing and idempotent registration. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { machineKeyId } from '../../../shared/machine-key-id.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { recordIso } from '../../../shared/record-timestamp.ts'
import type { ConfigTenant } from './record-config.ts'
import { tenant } from './record-config.ts'
import { ConfigServiceError } from './record-config-error.ts'

export type MachineKey = {
  keyId: string
  publicKey: Uint8Array
  signingPublicKey: Uint8Array | null
  label: string
  createdAt: string
  revokedAt: string | null
  userId: string | null
}

const bytes = (value: unknown) => new Uint8Array(value as ArrayBufferLike)
const nullableIso = (value: unknown) => (value == null ? null : recordIso(value))

function machineKeyRow(row: Record<string, unknown>): MachineKey {
  return {
    keyId: String(row.key_id),
    publicKey: bytes(row.public_key),
    signingPublicKey: row.signing_public_key == null ? null : bytes(row.signing_public_key),
    label: String(row.label),
    createdAt: recordIso(row.created_at),
    revokedAt: nullableIso(row.revoked_at),
    userId: row.user_id == null ? null : String(row.user_id),
  }
}

export async function listMachineKeys(input: ConfigTenant): Promise<MachineKey[]> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT key_id, public_key, signing_public_key, label, created_at, revoked_at, user_id
      FROM machine_public_key WHERE space_id=${input.spaceId}::uuid
      ORDER BY created_at, key_id
    `
    return rows.map((row: Record<string, unknown>) => machineKeyRow(row))
  })
}

export async function registerMachineKey(
  input: ConfigTenant & {
    keyId: string
    publicKey: Uint8Array
    signingPublicKey?: Uint8Array
    label: string
  },
): Promise<MachineKey> {
  const derived = await machineKeyId(input.publicKey)
  if (derived !== input.keyId) {
    throw new ConfigServiceError(
      'machine key id does not match public key; derive it as the first 16 bytes of SHA-256(publicKey), encoded as unpadded base64url',
      422,
    )
  }
  return tenant(input, async (tx) => {
    let rows = await tx`
      INSERT INTO machine_public_key
        (id, space_id, user_id, key_id, public_key, signing_public_key, label, created_at)
      VALUES
        (${newRecordId()}::uuid, ${input.spaceId}::uuid, ${input.userId}::uuid, ${input.keyId}, ${input.publicKey}, ${input.signingPublicKey ?? null}, ${input.label}, now())
      ON CONFLICT (space_id, key_id) DO NOTHING
      RETURNING key_id, public_key, signing_public_key, label, created_at, revoked_at, user_id
    `
    if (!rows[0]) {
      rows = await tx`
        SELECT key_id, public_key, signing_public_key, label, created_at, revoked_at, user_id
        FROM machine_public_key
        WHERE space_id=${input.spaceId}::uuid AND key_id=${input.keyId}
        FOR UPDATE
      `
    }
    let row = rows[0] as Record<string, unknown>
    if (!Buffer.from(bytes(row.public_key)).equals(Buffer.from(input.publicKey)))
      throw new ConfigServiceError(
        'machine key id is already registered with a different public key',
        409,
      )
    if (row.user_id != null && String(row.user_id) !== input.userId)
      throw new ConfigServiceError(
        `machine key ${input.keyId} belongs to another user; register from the owning user's machine, or initialize a new key on this machine with \`${PLATFORM_SLUG} machine config machine init --space <slug>\``,
        409,
      )
    if (input.signingPublicKey) {
      if (row.signing_public_key == null) {
        const updated = await tx`
          UPDATE machine_public_key SET signing_public_key=${input.signingPublicKey}
          WHERE space_id=${input.spaceId}::uuid AND key_id=${input.keyId}
          RETURNING key_id, public_key, signing_public_key, label, created_at, revoked_at, user_id
        `
        row = updated[0] as Record<string, unknown>
      } else if (
        !Buffer.from(bytes(row.signing_public_key)).equals(Buffer.from(input.signingPublicKey))
      ) {
        throw new ConfigServiceError(
          `machine key ${input.keyId} is already registered with a different signing key`,
          409,
        )
      }
    }
    return machineKeyRow(row)
  })
}
