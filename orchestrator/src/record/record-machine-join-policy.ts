// concern: machine join relay policy
/** Decides mailbox lifetime, occupancy, conflicts, limits and allocation without I/O. */

export const MACHINE_JOIN_NAMEPLATE_TTL_MS = 10 * 60_000
export const MACHINE_JOIN_MESSAGE_MAX_BYTES = 4096
export const MACHINE_JOIN_RATE_WINDOW_MS = 60 * 60_000
export const MACHINE_JOIN_ALLOCATIONS_PER_WINDOW = 20
export const MACHINE_JOIN_FAILURES_PER_WINDOW = 5
export const MACHINE_JOIN_NAMEPLATE_MAX = 999_999

export type MachineJoinAvailability = 'active' | 'expired' | 'burned'

export function machineJoinAvailability(input: {
  now: number
  expiresAt: number
  failedAt: number | null
}): MachineJoinAvailability {
  if (input.failedAt !== null) return 'burned'
  return input.now >= input.expiresAt ? 'expired' : 'active'
}

export function machineJoinIsCrowded(existingSides: readonly string[], side: string): boolean {
  const sides = new Set(existingSides)
  return !sides.has(side) && sides.size >= 2
}

export type MachineJoinPhaseDecision = 'insert' | 'resend' | 'conflict'

export function machineJoinPhaseDecision(
  existingBody: Uint8Array | null,
  body: Uint8Array,
): MachineJoinPhaseDecision {
  if (existingBody === null) return 'insert'
  return Buffer.from(existingBody).equals(Buffer.from(body)) ? 'resend' : 'conflict'
}

export function machineJoinRateLimited(count: number, limit: number): boolean {
  return count >= limit
}

export function lowestFreeMachineJoinNameplate(used: ReadonlySet<number>): number | null {
  for (let value = 1; value <= MACHINE_JOIN_NAMEPLATE_MAX; value += 1) {
    if (!used.has(value)) return value
  }
  return null
}
