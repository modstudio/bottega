// concern: run-liveness-policy
/** Time bounds and pure policy shared by run liveness and admission. */

import { isFreshRunHostWait } from './run-host-capacity.ts'

/**
 * The outer ceiling for a run and for callers waiting on one. Liveness itself
 * comes from the coordinator's kernel lease; elapsed time is not evidence that
 * a quiet worker, including one blocked on a ruling, has died.
 */
export const STALE_AFTER_MS = 60 * 60 * 1000
const DETACHED_AGENT_CAPACITY_STALE_MARGIN_MS = 5 * 60_000
// Agent selection must finish before liveness can classify its reserved run as stale.
export const DETACHED_AGENT_CAPACITY_WAIT_MAX_MS =
  STALE_AFTER_MS - DETACHED_AGENT_CAPACITY_STALE_MARGIN_MS

/** Whether a running run is still within either capacity queue's live bound. */
export function isRunQueuedForCapacity(
  hostWaitSince: string | null | undefined,
  agentCapacityWaitSince: string | null | undefined,
  clock = Date.now(),
): boolean {
  if (isFreshRunHostWait('running', hostWaitSince, clock)) return true
  if (!agentCapacityWaitSince) return false
  const started = Date.parse(agentCapacityWaitSince)
  return Number.isFinite(started) && clock - started <= DETACHED_AGENT_CAPACITY_WAIT_MAX_MS
}
