// concern: run-liveness-policy
/** Dependency-free time bounds and pure policy shared by run liveness and admission. */

export const RUN_HOST_WAIT_MAX_MS = 15 * 60_000
export const RUN_HOST_WAIT_POLL_MS = 1_000

export function isFreshRunHostWait(
  status: string,
  since: string | null | undefined,
  now = Date.now(),
): boolean {
  if (status !== 'running' || !since) return false
  const started = Date.parse(since)
  return Number.isFinite(started) && now - started <= RUN_HOST_WAIT_MAX_MS + RUN_HOST_WAIT_POLL_MS
}

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
