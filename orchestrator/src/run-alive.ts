// concern: run-alive
/** Owns only the pure decision whether a recorded run is alive. Must not perform I/O. */

export type RunLeaseState = 'held' | 'free' | 'missing'

/** Answer whether a run is alive, independently of whether it still claims resources. */
export function runAlive(input: {
  status: string
  lease: RunLeaseState
  pidAlive: boolean
}): boolean {
  if (input.status === 'asking') return true
  if (input.status !== 'running') return false
  if (input.lease === 'held') return true
  if (input.lease === 'free') return false
  return input.pidAlive
}
