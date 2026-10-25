// concern: run-liveness-policy
/** Dependency-free time bounds shared by run liveness and admission. */

export const STALE_AFTER_MS = 60 * 60 * 1000
const DETACHED_AGENT_CAPACITY_STALE_MARGIN_MS = 5 * 60_000
// Agent selection must finish before liveness can classify its reserved run as stale.
export const DETACHED_AGENT_CAPACITY_WAIT_MAX_MS =
  STALE_AFTER_MS - DETACHED_AGENT_CAPACITY_STALE_MARGIN_MS
