/** Stop close-out waits for the coordinator's lease, then decides whether to reclaim. */

export const STOP_CLOSE_OUT_LEASE_WAIT_MS = 30_000

export type StopCloseOutLeaseOutcome = 'free' | 'held-then-free' | 'still-held'

export type StopCloseOutDecision =
  | { action: 'run-close-out' }
  | { action: 'leave-for-sweep'; coordinatorPid: number | null }

/** Decide stop's reader-clone close-out from the lease wait and coordinator liveness. */
export function decideStopCloseOut(input: {
  lease: StopCloseOutLeaseOutcome
  coordinatorAlive: boolean
  coordinatorPid: number | null
}): StopCloseOutDecision {
  if (input.lease !== 'still-held') return { action: 'run-close-out' }
  return {
    action: 'leave-for-sweep',
    coordinatorPid: input.coordinatorAlive ? input.coordinatorPid : null,
  }
}

function waitMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Poll the close-out lease until it is free or the named bound elapses. */
export function waitForStopCloseOutLease(
  runId: string,
  boundMs: number,
  deps: {
    leaseHeld: (id: string) => boolean
    now?: () => number
    wait?: (ms: number) => void
    pollMs?: number
  },
): StopCloseOutLeaseOutcome {
  if (!deps.leaseHeld(runId)) return 'free'
  const now = deps.now ?? Date.now
  const wait = deps.wait ?? waitMs
  const pollMs = deps.pollMs ?? 50
  const deadline = now() + boundMs
  while (now() < deadline) {
    wait(Math.min(pollMs, Math.max(0, deadline - now())))
    if (!deps.leaseHeld(runId)) return 'held-then-free'
  }
  return 'still-held'
}
