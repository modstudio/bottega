// concern: board-watch-decision
/** Pure reconnect and pull policy for the hosted board watcher. Must not know fetch, timers, or stores. */

/** Silence window: comfortably longer than the hosted stream heartbeat so one missed comment is not fatal. */
export const BOARD_WATCH_SILENCE_MS = 60_000
/** Slow pull while connected, covering a wake-up that never arrived. */
export const BOARD_WATCH_SLOW_INTERVAL_MS = 5 * 60_000
export const BOARD_WATCH_BACKOFF_BASE_MS = 1_000
export const BOARD_WATCH_BACKOFF_CAP_MS = 60_000

export type BoardWatchState = {
  attempt: number
  usedImmediateReconnect: boolean
  signedOut: boolean
  announcedSignedOut: boolean
}

export const initialBoardWatchState = (): BoardWatchState => ({
  attempt: 0,
  usedImmediateReconnect: false,
  signedOut: false,
  announcedSignedOut: false,
})

export type BoardWatchEvent =
  | { kind: 'unconfigured' }
  | { kind: 'build-changed' }
  | { kind: 'opened' }
  | { kind: 'first-event' }
  | { kind: 'silence' }
  | { kind: 'ended-normal' }
  | { kind: 'ended-error' }
  | { kind: 'unauthorized' }

export type BoardWatchDecision = {
  state: BoardWatchState
  action: 'exit' | 'stay' | 'reconnect'
  reason?: 'unconfigured' | 'newer-build' | 'silence' | 'ended' | 'error' | 'unauthorized'
  delayMs?: number
  announce?: 'signed-out' | 'connected'
}

export function boardWatchBackoffMs(attempt: number, jitter: number): number {
  const unit = Math.min(1, Math.max(0, jitter))
  const growth = Math.min(16, Math.max(0, attempt))
  const cap = Math.min(BOARD_WATCH_BACKOFF_CAP_MS, BOARD_WATCH_BACKOFF_BASE_MS * 2 ** growth)
  return Math.floor(cap * (0.5 + 0.5 * unit))
}

export function boardWatchShouldPull(input: {
  reason: 'connect' | 'event' | 'slow'
  revision?: string
  cursor: string
}): boolean {
  if (input.reason === 'connect' || input.reason === 'slow') return true
  const revision = input.revision
  if (revision === undefined) return false
  return BigInt(revision) > BigInt(input.cursor)
}

function reconnect(
  state: BoardWatchState,
  reason: 'silence' | 'ended' | 'error',
  delayMs: number,
): BoardWatchDecision {
  return {
    state: { ...state, attempt: state.attempt + 1 },
    action: 'reconnect',
    reason,
    delayMs,
  }
}

export function decideBoardWatch(
  state: BoardWatchState,
  event: BoardWatchEvent,
  jitter: number,
): BoardWatchDecision {
  if (event.kind === 'unconfigured') return { state, action: 'exit', reason: 'unconfigured' }
  if (event.kind === 'build-changed') return { state, action: 'exit', reason: 'newer-build' }
  if (event.kind === 'opened') {
    return {
      state: { ...state, signedOut: false },
      action: 'stay',
      announce: state.signedOut ? 'connected' : undefined,
    }
  }
  if (event.kind === 'first-event') {
    return {
      state: { ...state, attempt: 0, usedImmediateReconnect: false },
      action: 'stay',
    }
  }
  if (event.kind === 'unauthorized') {
    return {
      state: { ...state, signedOut: true, announcedSignedOut: true, attempt: state.attempt + 1 },
      action: 'reconnect',
      reason: 'unauthorized',
      delayMs: BOARD_WATCH_BACKOFF_CAP_MS,
      announce: state.announcedSignedOut ? undefined : 'signed-out',
    }
  }
  if (event.kind === 'ended-normal' && !state.usedImmediateReconnect) {
    return {
      state: { ...state, usedImmediateReconnect: true },
      action: 'reconnect',
      reason: 'ended',
      delayMs: 0,
    }
  }
  const reason =
    event.kind === 'silence' ? 'silence' : event.kind === 'ended-normal' ? 'ended' : 'error'
  return reconnect(state, reason, boardWatchBackoffMs(state.attempt, jitter))
}
