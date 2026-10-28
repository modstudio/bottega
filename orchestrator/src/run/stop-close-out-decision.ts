/** Stop close-out decides whether to reclaim from the lease wait and coordinator liveness. */

export const STOP_CLOSE_OUT_LEASE_WAIT_MS = 30_000

export type StopCloseOutLeaseOutcome = 'free' | 'held-then-free' | 'still-held'

export type StopCloseOutDecision =
  | { action: 'run-close-out'; extraPids: number[] }
  | { action: 'leave-for-sweep'; coordinatorPid: number | null }

function stopCloseOutExtraPids(
  lease: StopCloseOutLeaseOutcome,
  coordinatorPid: number | null,
): number[] {
  // held-then-free: the coordinator finished with the tree, so omit it.
  // free from the start: it may still be in the creation window, so keep it.
  if (lease !== 'free' || coordinatorPid == null) return []
  return [coordinatorPid]
}

/** Decide stop's reader-clone close-out from the lease wait and coordinator liveness. */
export function decideStopCloseOut(input: {
  lease: StopCloseOutLeaseOutcome
  coordinatorAlive: boolean
  coordinatorPid: number | null
}): StopCloseOutDecision {
  if (input.lease === 'still-held') {
    return {
      action: 'leave-for-sweep',
      coordinatorPid: input.coordinatorAlive ? input.coordinatorPid : null,
    }
  }
  return {
    action: 'run-close-out',
    extraPids: stopCloseOutExtraPids(input.lease, input.coordinatorPid),
  }
}
