// concern: store-open migration window decision
/** Decides whether a store open waits for a live machine update or refuses. */

export const MIGRATION_WINDOW_POLL_MS = 500
export const MIGRATION_WINDOW_WAIT_MS = 120_000

type MigrationWindowHolder = {
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
  holder: MigrationWindowHolder | null
  elapsedMs: number
}): MigrationWindowDecision {
  if (input.refusal === null) return { action: 'open' }
  if (
    input.behind &&
    input.holder?.liveness === 'live' &&
    input.elapsedMs < MIGRATION_WINDOW_WAIT_MS
  ) {
    return { action: 'wait' }
  }
  if (input.behind && input.holder) {
    return {
      action: 'refuse',
      message:
        `refusing to open the store while machine update is migrating ` +
        `(holder pid ${input.holder.pid}); retry this call when it finishes`,
    }
  }
  return { action: 'refuse', message: input.refusal }
}

export type MigrationWindowClaimDecision =
  | { action: 'claim' }
  | { action: 'wait' }
  | { action: 'refuse'; message: string }

export function decideMigrationWindowClaim(input: {
  holder: (MigrationWindowHolder & { migration: string }) | null
  elapsedMs: number
}): MigrationWindowClaimDecision {
  if (!input.holder) return { action: 'claim' }
  if (input.holder.liveness === 'live' && input.elapsedMs < MIGRATION_WINDOW_WAIT_MS) {
    return { action: 'wait' }
  }
  return {
    action: 'refuse',
    message:
      `migration window is already active for ${input.holder.migration} ` +
      `(holder pid ${input.holder.pid}); re-run this command after that update finishes`,
  }
}
