// concern: process-liveness
/**
 * Knows whether an operating-system process id is alive. Must not know runs,
 * worktrees, the database, routing, transports, or CLI adapters.
 */
/** Test whether a recorded worker process still exists without touching it. */
export function pidAlive(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
