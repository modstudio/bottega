// concern: board-watch-decision
/** Pure reconnect and pull policy for the hosted board watcher. Must not know fetch, timers, or stores. */

/** Silence window: comfortably longer than the hosted stream heartbeat so one missed comment is not fatal. */
export const BOARD_WATCH_SILENCE_MS = 60_000
/** Slow pull while connected, covering a wake-up that never arrived. */
export const BOARD_WATCH_SLOW_INTERVAL_MS = 5 * 60_000
/** How often a long-lived watcher compares its started build to the installed one. */
export const BOARD_WATCH_BUILD_CHECK_MS = 2 * 60_000
export const BOARD_WATCH_BACKOFF_BASE_MS = 1_000
export const BOARD_WATCH_BACKOFF_CAP_MS = 60_000
/** Unsuccessful exit so the service manager replaces a watcher whose build is no longer installed. */
export const BOARD_WATCH_NEWER_BUILD_EXIT_CODE = 1

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
  | { kind: 'event'; revision: string; cursor: string }
  | { kind: 'slow-timer' }
  | { kind: 'silence' }
  | { kind: 'ended' }
  | { kind: 'error' }
  | { kind: 'unauthorized' }
  | { kind: 'pull-failed'; reason: string }
  | { kind: 'pull-incomplete' }

export type BoardWatchAnnounce =
  | { kind: 'connected' }
  | { kind: 'signed-out' }
  | { kind: 'disconnected'; reason: 'silence' | 'ended' | 'error' }
  | { kind: 'unconfigured' }
  | { kind: 'newer-build' }
  | { kind: 'pull-failed'; detail: string }

export type BoardWatchDecision = {
  state: BoardWatchState
  action: 'exit' | 'stay' | 'reconnect'
  exitCode: number | null
  delayMs: number
  pull: boolean
  announce: BoardWatchAnnounce | null
}

export function boardWatchBackoffMs(attempt: number, jitter: number): number {
  const unit = Math.min(1, Math.max(0, jitter))
  const growth = Math.min(16, Math.max(0, attempt))
  const cap = Math.min(BOARD_WATCH_BACKOFF_CAP_MS, BOARD_WATCH_BACKOFF_BASE_MS * 2 ** growth)
  return Math.floor(cap * (0.5 + 0.5 * unit))
}

export function boardWatchWaitMs(input: {
  now: number
  lastByte: number
  lastSlow: number
  lastBuild: number
}): number {
  return Math.max(
    0,
    Math.min(
      BOARD_WATCH_SILENCE_MS - (input.now - input.lastByte),
      BOARD_WATCH_SLOW_INTERVAL_MS - (input.now - input.lastSlow),
      BOARD_WATCH_BUILD_CHECK_MS - (input.now - input.lastBuild),
    ),
  )
}

export function boardWatchDueEvent(input: {
  now: number
  lastByte: number
  lastSlow: number
  lastBuild: number
}): 'silence' | 'slow-timer' | 'build-check' | null {
  if (input.now - input.lastByte >= BOARD_WATCH_SILENCE_MS) return 'silence'
  if (input.now - input.lastBuild >= BOARD_WATCH_BUILD_CHECK_MS) return 'build-check'
  if (input.now - input.lastSlow >= BOARD_WATCH_SLOW_INTERVAL_MS) return 'slow-timer'
  return null
}

export function boardWatchPullEvent(
  result: { kind: 'ok' | 'incomplete' | 'failed'; reason?: string },
  cursor: string,
  target: string | null,
): BoardWatchEvent | null {
  if (result.kind === 'failed') return { kind: 'pull-failed', reason: result.reason ?? 'failed' }
  if (result.kind === 'incomplete') return { kind: 'pull-incomplete' }
  if (target !== null && BigInt(cursor) < BigInt(target)) return { kind: 'pull-incomplete' }
  return null
}

function stay(
  state: BoardWatchState,
  extras: Partial<Pick<BoardWatchDecision, 'pull' | 'announce' | 'delayMs'>> = {},
): BoardWatchDecision {
  return {
    state,
    action: 'stay',
    exitCode: null,
    delayMs: extras.delayMs ?? 0,
    pull: extras.pull ?? false,
    announce: extras.announce ?? null,
  }
}

function exit(
  state: BoardWatchState,
  exitCode: number,
  announce: BoardWatchAnnounce,
): BoardWatchDecision {
  return { state, action: 'exit', exitCode, delayMs: 0, pull: false, announce }
}

function reconnect(
  state: BoardWatchState,
  reason: 'silence' | 'ended' | 'error',
  delayMs: number,
): BoardWatchDecision {
  return {
    state: { ...state, attempt: state.attempt + 1 },
    action: 'reconnect',
    exitCode: null,
    delayMs,
    pull: false,
    announce: { kind: 'disconnected', reason },
  }
}

function decideOpened(state: BoardWatchState): BoardWatchDecision {
  return stay({ ...state, signedOut: false }, { pull: true, announce: { kind: 'connected' } })
}

function decideFirstEvent(state: BoardWatchState): BoardWatchDecision {
  return stay({ ...state, attempt: 0, usedImmediateReconnect: false })
}

function decideEvent(
  state: BoardWatchState,
  event: { revision: string; cursor: string },
): BoardWatchDecision {
  return stay(state, { pull: BigInt(event.revision) > BigInt(event.cursor) })
}

function decideUnauthorized(state: BoardWatchState): BoardWatchDecision {
  return {
    state: { ...state, signedOut: true, announcedSignedOut: true, attempt: state.attempt + 1 },
    action: 'reconnect',
    exitCode: null,
    delayMs: BOARD_WATCH_BACKOFF_CAP_MS,
    pull: false,
    announce: state.announcedSignedOut ? null : { kind: 'signed-out' },
  }
}

function decideEnded(state: BoardWatchState, jitter: number): BoardWatchDecision {
  if (!state.usedImmediateReconnect) {
    return {
      state: { ...state, usedImmediateReconnect: true },
      action: 'reconnect',
      exitCode: null,
      delayMs: 0,
      pull: false,
      announce: { kind: 'disconnected', reason: 'ended' },
    }
  }
  return reconnect(state, 'ended', boardWatchBackoffMs(state.attempt, jitter))
}

function decidePullFailed(
  state: BoardWatchState,
  reason: string,
  jitter: number,
): BoardWatchDecision {
  return stay(
    { ...state, attempt: state.attempt + 1 },
    {
      pull: true,
      delayMs: boardWatchBackoffMs(state.attempt, jitter),
      announce: { kind: 'pull-failed', detail: reason },
    },
  )
}

export function decideBoardWatch(
  state: BoardWatchState,
  event: BoardWatchEvent,
  jitter: number,
): BoardWatchDecision {
  switch (event.kind) {
    case 'unconfigured':
      return exit(state, 0, { kind: 'unconfigured' })
    case 'build-changed':
      return exit(state, BOARD_WATCH_NEWER_BUILD_EXIT_CODE, { kind: 'newer-build' })
    case 'opened':
      return decideOpened(state)
    case 'first-event':
      return decideFirstEvent(state)
    case 'event':
      return decideEvent(state, event)
    case 'slow-timer':
      return stay(state, { pull: true })
    case 'silence':
      return reconnect(state, 'silence', boardWatchBackoffMs(state.attempt, jitter))
    case 'ended':
      return decideEnded(state, jitter)
    case 'error':
      return reconnect(state, 'error', boardWatchBackoffMs(state.attempt, jitter))
    case 'unauthorized':
      return decideUnauthorized(state)
    case 'pull-failed':
      return decidePullFailed(state, event.reason, jitter)
    case 'pull-incomplete':
      return stay(state, { pull: true })
  }
}
