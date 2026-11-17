// concern: terminal lifecycle verdict
/** Keeps architect lifecycle decisions authoritative over a worker's late terminal result. */

export type StoredTerminalLifecycle = {
  status: string
  error: string | null
  failureKind: string | null
}

/** An architect lifecycle verdict is final even if the worker later finishes. */
function hasArchitectLifecycleVerdict(outcome: StoredTerminalLifecycle): boolean {
  return (
    outcome.status === 'stopped' ||
    (outcome.status === 'stale' && outcome.failureKind === 'abandoned')
  )
}

/** Choose the lifecycle fields written beside an otherwise complete terminal measurement. */
export function terminalLifecycleForWrite(
  stored: StoredTerminalLifecycle,
  incoming: StoredTerminalLifecycle,
): StoredTerminalLifecycle {
  return hasArchitectLifecycleVerdict(stored) ? stored : incoming
}
