// concern: store-open migration window decision
/** Decides whether a store open waits for a live machine update or refuses. */

export const MIGRATION_WINDOW_POLL_MS = 500
export const MIGRATION_WINDOW_WAIT_MS = 120_000

type MigrationWindowMarker = {
  phase: 'draining' | 'migrating'
  pid: number
  liveness: 'live' | 'unknown'
}

export type MigrationWindowDecision =
  | { action: 'open' }
  | { action: 'wait' }
  | { action: 'refuse'; message: string }

export function decideMigrationWindow(input: {
  behind: boolean
  refusal: string | null
  marker: MigrationWindowMarker | null
  elapsedMs: number
}): MigrationWindowDecision {
  if (input.refusal === null) return { action: 'open' }
  if (
    input.behind &&
    input.marker?.phase === 'migrating' &&
    input.marker.liveness === 'live' &&
    input.elapsedMs < MIGRATION_WINDOW_WAIT_MS
  ) {
    return { action: 'wait' }
  }
  if (input.behind && input.marker?.phase === 'migrating') {
    return {
      action: 'refuse',
      message:
        `refusing to open the store while machine update is migrating ` +
        `(holder pid ${input.marker.pid}); retry this call when it finishes`,
    }
  }
  return { action: 'refuse', message: input.refusal }
}
