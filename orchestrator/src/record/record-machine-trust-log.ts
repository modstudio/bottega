// concern: hosted machine trust log
/** Appends opaque signed trust entries to a tenant-bound, serialized record log. */

import { newRecordId } from '../../../shared/record/schema.ts'
import { decodeTrustLogEntry, trustLogEntryHash } from '../../../shared/trust-log.ts'
import type { ConfigTenant } from './record-config.ts'
import { tenant } from './record-config.ts'
import { ConfigServiceError, isUniqueViolation } from './record-config-error.ts'

const bytes = (value: unknown) => new Uint8Array(value as ArrayBufferLike)
const equal = (left: Uint8Array | null, right: Uint8Array | null) =>
  left === null || right === null ? left === right : Buffer.from(left).equals(Buffer.from(right))
const shown = (head: Uint8Array | null) =>
  head === null ? 'null' : Buffer.from(head).toString('base64url')

export async function readMachineTrustLog(input: ConfigTenant): Promise<Uint8Array[]> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT entry FROM machine_trust_log
      WHERE space_id=${input.spaceId}::uuid ORDER BY seq
    `
    return rows.map((row: Record<string, unknown>) => bytes(row.entry))
  })
}

export async function appendMachineTrustLogEntry(
  input: ConfigTenant & { expectedHead: Uint8Array | null; entry: Uint8Array },
): Promise<Uint8Array> {
  let decoded: ReturnType<typeof decodeTrustLogEntry>
  try {
    decoded = decodeTrustLogEntry(input.entry)
  } catch (error) {
    throw new ConfigServiceError(
      `malformed machine trust log entry: ${error instanceof Error ? error.message : String(error)}`,
      400,
    )
  }
  if (decoded.space !== input.spaceId)
    throw new ConfigServiceError(
      'machine trust log entry space does not match the request space',
      400,
    )
  if (!equal(decoded.prev, input.expectedHead))
    throw new ConfigServiceError('machine trust log entry prev does not match expectedHead', 400)
  if (input.expectedHead === null && decoded.body.kind !== 'genesis')
    throw new ConfigServiceError(
      'machine trust log entry with a null expectedHead must be genesis',
      400,
    )
  const hash = trustLogEntryHash(input.entry)
  try {
    return await tenant(input, async (tx) => {
      const rows = await tx`
        SELECT seq, hash FROM machine_trust_log
        WHERE space_id=${input.spaceId}::uuid ORDER BY seq DESC LIMIT 1
      `
      const row = rows[0] as Record<string, unknown> | undefined
      const current = row ? bytes(row.hash) : null
      if (!equal(current, input.expectedHead))
        throw new ConfigServiceError(
          `machine trust log head is ${shown(current)}, not ${shown(input.expectedHead)}; read the log again, verify it and retry`,
          409,
        )
      const seq = row ? Number(row.seq) + 1 : 0
      await tx`
        INSERT INTO machine_trust_log (id, space_id, seq, hash, prev_hash, entry, created_at)
        VALUES (${newRecordId()}::uuid, ${input.spaceId}::uuid, ${seq}, ${hash}, ${input.expectedHead}, ${input.entry}, now())
      `
      return hash
    })
  } catch (error) {
    if (
      isUniqueViolation(error, 'machine_trust_log_space_seq_unique') ||
      isUniqueViolation(error, 'machine_trust_log_space_hash_unique')
    )
      throw new ConfigServiceError(
        'machine trust log changed concurrently; read the log again, verify it and retry',
        409,
      )
    throw error
  }
}
