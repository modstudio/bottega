// concern: hosted machine join relay
/** Stores and forwards opaque, tenant-bound pairing messages under serialized nameplates. */

import type { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import type { ConfigTenant } from './record-config.ts'
import { tenant } from './record-config.ts'
import { ConfigServiceError, isUniqueViolation } from './record-config-error.ts'
import {
  lowestFreeMachineJoinNameplate,
  MACHINE_JOIN_ALLOCATIONS_PER_WINDOW,
  MACHINE_JOIN_FAILURES_PER_WINDOW,
  MACHINE_JOIN_NAMEPLATE_TTL_MS,
  MACHINE_JOIN_RATE_WINDOW_MS,
  machineJoinAvailability,
  machineJoinIsCrowded,
  machineJoinPhaseDecision,
  machineJoinRateLimited,
} from './record-machine-join-policy.ts'

type NameplateRow = Record<string, unknown>
type MachineJoinMessage = { side: string; phase: string; body: Uint8Array }
export type MachineJoinMailbox = { expiresAt: string; messages: MachineJoinMessage[] }

const bytes = (value: unknown) => new Uint8Array(value as ArrayBufferLike)
const iso = (value: unknown) => new Date(value as string | number | Date).toISOString()
const restartRemedy = 'both machines must start again with a new pairing code'

function missingNameplate(): never {
  throw new ConfigServiceError(
    'machine join nameplate was not found in this space; request a new pairing code, then retry',
    404,
  )
}

function requireActive(row: NameplateRow, now: number): void {
  const availability = machineJoinAvailability({
    now,
    expiresAt: new Date(row.expires_at as string | Date).getTime(),
    failedAt: row.failed_at == null ? null : new Date(row.failed_at as string | Date).getTime(),
  })
  if (availability !== 'active')
    throw new ConfigServiceError(`machine join nameplate is ${availability}; ${restartRemedy}`, 410)
}

async function lockNameplate(
  tx: SQL,
  input: ConfigTenant & { nameplate: string },
): Promise<NameplateRow> {
  let rows = await tx`
    SELECT id, expires_at, failed_at FROM machine_join_nameplate
    WHERE space_id=${input.spaceId}::uuid AND nameplate=${input.nameplate}
  `
  const found = rows[0] as NameplateRow | undefined
  if (!found) missingNameplate()
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`machine-join:${String(found.id)}`}, 0))`
  rows = await tx`
    SELECT id, expires_at, failed_at FROM machine_join_nameplate
    WHERE id=${String(found.id)}::uuid
  `
  const locked = rows[0] as NameplateRow | undefined
  if (!locked) missingNameplate()
  return locked
}

async function failureCount(tx: SQL, userId: string, cutoff: Date): Promise<number> {
  const rows = await tx`
    SELECT count(DISTINCT n.id) AS count
    FROM machine_join_nameplate n
    LEFT JOIN machine_join_message m ON m.nameplate_id=n.id
    WHERE n.failed_at IS NOT NULL AND n.created_at >= ${cutoff}
      AND (n.allocated_by=${userId}::uuid OR m.posted_by=${userId}::uuid OR n.failed_by=${userId}::uuid)
  `
  return Number(rows[0]?.count ?? 0)
}

function refuseFailureRate(): never {
  throw new ConfigServiceError(
    'machine join failed-exchange limit reached; wait for the one-hour rate window to pass, then start again',
    429,
  )
}

async function refuseWhenFailureLimitReached(tx: SQL, userId: string, now: number): Promise<void> {
  const cutoff = new Date(now - MACHINE_JOIN_RATE_WINDOW_MS)
  const count = await failureCount(tx, userId, cutoff)
  if (machineJoinRateLimited(count, MACHINE_JOIN_FAILURES_PER_WINDOW)) refuseFailureRate()
}

export async function allocateMachineJoinNameplate(
  input: ConfigTenant,
): Promise<{ nameplate: string; expiresAt: string }> {
  const now = Date.now()
  const cutoff = new Date(now - MACHINE_JOIN_RATE_WINDOW_MS)
  try {
    return await tenant(input, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`machine-join-space:${input.spaceId}`}, 0))`
      const allocated = await tx`
        SELECT count(*) AS count FROM machine_join_nameplate
        WHERE allocated_by=${input.userId}::uuid AND created_at >= ${cutoff}
      `
      if (
        machineJoinRateLimited(
          Number(allocated[0]?.count ?? 0),
          MACHINE_JOIN_ALLOCATIONS_PER_WINDOW,
        )
      )
        throw new ConfigServiceError(
          'machine join allocation limit reached; wait for the one-hour rate window to pass, then retry',
          429,
        )
      await refuseWhenFailureLimitReached(tx, input.userId, now)
      const rows = await tx`
        SELECT nameplate FROM machine_join_nameplate WHERE space_id=${input.spaceId}::uuid
      `
      const used = new Set<number>(
        rows.map((row: Record<string, unknown>) => Number(row.nameplate)),
      )
      const value = lowestFreeMachineJoinNameplate(used)
      if (value === null)
        throw new ConfigServiceError(
          'machine join nameplates are exhausted in this space; wait for old nameplates to be pruned, then retry',
          409,
        )
      const nameplate = String(value)
      const expiresAt = new Date(now + MACHINE_JOIN_NAMEPLATE_TTL_MS)
      await tx`
        INSERT INTO machine_join_nameplate
          (id, space_id, nameplate, allocated_by, created_at, expires_at)
        VALUES
          (${newRecordId()}::uuid, ${input.spaceId}::uuid, ${nameplate}, ${input.userId}::uuid, ${new Date(now)}, ${expiresAt})
      `
      return { nameplate, expiresAt: expiresAt.toISOString() }
    })
  } catch (error) {
    if (isUniqueViolation(error, 'machine_join_nameplate_space_nameplate_unique'))
      throw new ConfigServiceError(
        'machine join nameplate changed concurrently; request a new pairing code, then retry',
        409,
      )
    throw error
  }
}

export async function postMachineJoinMessage(
  input: ConfigTenant & { nameplate: string; side: string; phase: string; body: Uint8Array },
): Promise<void> {
  const now = Date.now()
  try {
    await tenant(input, async (tx) => {
      const nameplate = await lockNameplate(tx, input)
      requireActive(nameplate, now)
      await refuseWhenFailureLimitReached(tx, input.userId, now)
      const rows = await tx`
        SELECT side, phase, body FROM machine_join_message
        WHERE nameplate_id=${String(nameplate.id)}::uuid ORDER BY created_at, id
      `
      if (
        machineJoinIsCrowded(
          rows.map((row: Record<string, unknown>) => String(row.side)),
          input.side,
        )
      )
        throw new ConfigServiceError(`machine join nameplate is crowded; ${restartRemedy}`, 409)
      const existing = rows.find(
        (row: Record<string, unknown>) => row.side === input.side && row.phase === input.phase,
      ) as Record<string, unknown> | undefined
      const decision = machineJoinPhaseDecision(existing ? bytes(existing.body) : null, input.body)
      if (decision === 'conflict')
        throw new ConfigServiceError(
          `machine join phase already has a different message; ${restartRemedy}`,
          409,
        )
      if (decision === 'resend') return
      await tx`
        INSERT INTO machine_join_message
          (id, nameplate_id, space_id, side, phase, body, posted_by, created_at)
        VALUES
          (${newRecordId()}::uuid, ${String(nameplate.id)}::uuid, ${input.spaceId}::uuid, ${input.side}, ${input.phase}, ${input.body}, ${input.userId}::uuid, ${new Date(now)})
      `
    })
  } catch (error) {
    if (isUniqueViolation(error, 'machine_join_message_nameplate_side_phase_unique'))
      throw new ConfigServiceError(`machine join phase changed concurrently; ${restartRemedy}`, 409)
    throw error
  }
}

export async function readMachineJoinMessages(
  input: ConfigTenant & { nameplate: string; side: string },
): Promise<MachineJoinMailbox> {
  const now = Date.now()
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT id, expires_at, failed_at FROM machine_join_nameplate
      WHERE space_id=${input.spaceId}::uuid AND nameplate=${input.nameplate}
    `
    const nameplate = rows[0] as NameplateRow | undefined
    if (!nameplate) missingNameplate()
    requireActive(nameplate, now)
    const messages = await tx`
      SELECT side, phase, body FROM machine_join_message
      WHERE nameplate_id=${String(nameplate.id)}::uuid AND side <> ${input.side}
      ORDER BY created_at, id
    `
    return {
      expiresAt: iso(nameplate.expires_at),
      messages: messages.map((row: Record<string, unknown>) => ({
        side: String(row.side),
        phase: String(row.phase),
        body: bytes(row.body),
      })),
    }
  })
}

export async function failMachineJoinNameplate(
  input: ConfigTenant & { nameplate: string; side: string },
): Promise<void> {
  const now = Date.now()
  await tenant(input, async (tx) => {
    const nameplate = await lockNameplate(tx, input)
    if (nameplate.failed_at != null) return
    requireActive(nameplate, now)
    await refuseWhenFailureLimitReached(tx, input.userId, now)
    await tx`
      UPDATE machine_join_nameplate SET failed_at=${new Date(now)}, failed_by=${input.userId}::uuid
      WHERE id=${String(nameplate.id)}::uuid
    `
  })
}
