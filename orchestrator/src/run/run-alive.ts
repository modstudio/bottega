// concern: run-alive
/** Owns only the pure decision whether a recorded run is alive. Must not perform I/O. */

export type RunLeaseState = 'held' | 'free' | 'missing'

export type RecordedRunLiveness = {
  executor?: 'external' | 'harness'
  session_last_seen?: string | null
  started_at?: string
  harness_wall_bound_ms?: number | null
}

/** Derive processless liveness solely from facts carried by the row reader. */
export function recordedRunLivenessFacts(
  row: RecordedRunLiveness,
  now: number,
  sessionLiveMs: number,
  ownerProcess: 'live' | 'dead' | 'unknown' | 'missing' = 'missing',
): {
  executor?: 'external' | 'harness'
  ownerSessionAlive?: boolean
  wallBoundExceeded?: boolean
} {
  if (row.executor !== 'harness') return { executor: row.executor }
  return {
    executor: 'harness',
    ownerSessionAlive:
      ownerProcess === 'live' ||
      ((ownerProcess === 'missing' || ownerProcess === 'unknown') &&
        row.session_last_seen !== null &&
        row.session_last_seen !== undefined &&
        Date.parse(row.session_last_seen) >= now - sessionLiveMs),
    wallBoundExceeded:
      !row.started_at ||
      row.harness_wall_bound_ms === null ||
      row.harness_wall_bound_ms === undefined ||
      now - Date.parse(row.started_at) > row.harness_wall_bound_ms,
  }
}

/** Answer whether a run is alive, independently of whether it still claims resources. */
export function runAlive(input: {
  status: string
  lease: RunLeaseState
  pidAlive: boolean
  executor?: 'external' | 'harness'
  ownerSessionAlive?: boolean
  wallBoundExceeded?: boolean
}): boolean {
  if (input.status === 'asking') return true
  if (input.status !== 'running') return false
  if (input.executor === 'harness') {
    return Boolean(input.ownerSessionAlive) && !input.wallBoundExceeded
  }
  if (input.lease === 'held') return true
  if (input.lease === 'free') return false
  return input.pidAlive
}
