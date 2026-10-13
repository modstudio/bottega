import { expect, test } from 'bun:test'
import {
  BOARD_WATCH_BACKOFF_BASE_MS,
  BOARD_WATCH_BACKOFF_CAP_MS,
  BOARD_WATCH_BUILD_CHECK_MS,
  BOARD_WATCH_NEWER_BUILD_EXIT_CODE,
  BOARD_WATCH_SILENCE_MS,
  BOARD_WATCH_SLOW_INTERVAL_MS,
  boardWatchBackoffMs,
  boardWatchDueEvent,
  boardWatchPullEvent,
  boardWatchWaitMs,
  decideBoardWatch,
  initialBoardWatchState,
} from './board-watch-decision.ts'

const fullJitter = 1

test('missing record API configuration exits zero', () => {
  const decision = decideBoardWatch(initialBoardWatchState(), { kind: 'unconfigured' }, fullJitter)
  expect(decision.action).toBe('exit')
  expect(decision.exitCode).toBe(0)
  expect(decision.announce).toEqual({ kind: 'unconfigured' })
})

test('a changed build exits with the named unsuccessful code', () => {
  const decision = decideBoardWatch(initialBoardWatchState(), { kind: 'build-changed' }, fullJitter)
  expect(decision.action).toBe('exit')
  expect(decision.exitCode).toBe(BOARD_WATCH_NEWER_BUILD_EXIT_CODE)
  expect(decision.exitCode).not.toBe(0)
  expect(decision.announce).toEqual({ kind: 'newer-build' })
})

test('opening a stream stays, pulls, and announces connected', () => {
  const decision = decideBoardWatch(initialBoardWatchState(), { kind: 'opened' }, fullJitter)
  expect(decision).toMatchObject({
    action: 'stay',
    pull: true,
    announce: { kind: 'connected' },
  })
})

test('opening after signed-out announces connected once', () => {
  const signedOut = decideBoardWatch(initialBoardWatchState(), { kind: 'unauthorized' }, fullJitter)
  expect(signedOut.announce).toEqual({ kind: 'signed-out' })
  const again = decideBoardWatch(signedOut.state, { kind: 'unauthorized' }, fullJitter)
  expect(again.announce).toBeNull()
  expect(again.delayMs).toBe(BOARD_WATCH_BACKOFF_CAP_MS)
  const recovered = decideBoardWatch(again.state, { kind: 'opened' }, fullJitter)
  expect(recovered.announce).toEqual({ kind: 'connected' })
  expect(recovered.state.signedOut).toBe(false)
})

test('silence reconnects with exponential backoff', () => {
  const first = decideBoardWatch(initialBoardWatchState(), { kind: 'silence' }, fullJitter)
  expect(first).toMatchObject({
    action: 'reconnect',
    delayMs: BOARD_WATCH_BACKOFF_BASE_MS,
    announce: { kind: 'disconnected', reason: 'silence' },
  })
  const second = decideBoardWatch(first.state, { kind: 'silence' }, fullJitter)
  expect(second.delayMs).toBe(BOARD_WATCH_BACKOFF_BASE_MS * 2)
})

test('a stream the server ended normally reconnects without delay once, then backs off', () => {
  const first = decideBoardWatch(initialBoardWatchState(), { kind: 'ended' }, fullJitter)
  expect(first).toMatchObject({
    action: 'reconnect',
    delayMs: 0,
    announce: { kind: 'disconnected', reason: 'ended' },
  })
  const second = decideBoardWatch(first.state, { kind: 'ended' }, fullJitter)
  expect(second.delayMs).toBe(BOARD_WATCH_BACKOFF_BASE_MS)
})

test('the first event resets backoff so the next normal end is immediate again', () => {
  const ended = decideBoardWatch(initialBoardWatchState(), { kind: 'ended' }, fullJitter)
  const reset = decideBoardWatch(ended.state, { kind: 'first-event' }, fullJitter)
  expect(reset.state).toEqual(initialBoardWatchState())
  const next = decideBoardWatch(reset.state, { kind: 'ended' }, fullJitter)
  expect(next.delayMs).toBe(0)
})

test('a stream error uses backoff', () => {
  const decision = decideBoardWatch(initialBoardWatchState(), { kind: 'error' }, fullJitter)
  expect(decision).toMatchObject({
    action: 'reconnect',
    delayMs: BOARD_WATCH_BACKOFF_BASE_MS,
    announce: { kind: 'disconnected', reason: 'error' },
  })
})

test('backoff is bounded and scaled by jitter', () => {
  expect(boardWatchBackoffMs(0, 1)).toBe(BOARD_WATCH_BACKOFF_BASE_MS)
  expect(boardWatchBackoffMs(0, 0)).toBe(BOARD_WATCH_BACKOFF_BASE_MS / 2)
  expect(boardWatchBackoffMs(20, 1)).toBe(BOARD_WATCH_BACKOFF_CAP_MS)
  const jittered = decideBoardWatch(initialBoardWatchState(), { kind: 'silence' }, 0)
  expect(jittered.delayMs).toBe(BOARD_WATCH_BACKOFF_BASE_MS / 2)
})

test('an event ahead of the cursor is a pull; one at or behind it is not', () => {
  expect(
    decideBoardWatch(
      initialBoardWatchState(),
      { kind: 'event', revision: '10', cursor: '9' },
      fullJitter,
    ).pull,
  ).toBe(true)
  expect(
    decideBoardWatch(
      initialBoardWatchState(),
      { kind: 'event', revision: '9', cursor: '9' },
      fullJitter,
    ).pull,
  ).toBe(false)
  expect(
    decideBoardWatch(
      initialBoardWatchState(),
      { kind: 'event', revision: '8', cursor: '9' },
      fullJitter,
    ).pull,
  ).toBe(false)
})

test('a slow timer pulls while staying connected', () => {
  const decision = decideBoardWatch(initialBoardWatchState(), { kind: 'slow-timer' }, fullJitter)
  expect(decision).toMatchObject({ action: 'stay', pull: true, announce: null })
})

test('a failed pull stays on the stream, announces, and retries on backoff', () => {
  const decision = decideBoardWatch(
    initialBoardWatchState(),
    { kind: 'pull-failed', reason: 'record API 500' },
    fullJitter,
  )
  expect(decision).toMatchObject({
    action: 'stay',
    pull: true,
    delayMs: BOARD_WATCH_BACKOFF_BASE_MS,
    announce: { kind: 'pull-failed', detail: 'record API 500' },
  })
})

test('an incomplete pull queues another immediately', () => {
  const decision = decideBoardWatch(
    initialBoardWatchState(),
    { kind: 'pull-incomplete' },
    fullJitter,
  )
  expect(decision).toMatchObject({ action: 'stay', pull: true, delayMs: 0 })
})

test('every observed input has a decision', () => {
  const kinds: Array<Parameters<typeof decideBoardWatch>[1]> = [
    { kind: 'unconfigured' },
    { kind: 'build-changed' },
    { kind: 'opened' },
    { kind: 'first-event' },
    { kind: 'event', revision: '2', cursor: '1' },
    { kind: 'slow-timer' },
    { kind: 'silence' },
    { kind: 'ended' },
    { kind: 'error' },
    { kind: 'unauthorized' },
    { kind: 'pull-failed', reason: 'offline' },
    { kind: 'pull-incomplete' },
  ]
  for (const event of kinds) {
    const decision = decideBoardWatch(initialBoardWatchState(), event, fullJitter)
    expect(
      decision.action === 'exit' || decision.action === 'stay' || decision.action === 'reconnect',
    ).toBe(true)
  }
})

test('timer due events prefer silence, then the build check, then the slow pull', () => {
  const origin = 0
  expect(
    boardWatchDueEvent({
      now: origin + BOARD_WATCH_SILENCE_MS,
      lastByte: origin,
      lastSlow: origin,
      lastBuild: origin,
    }),
  ).toBe('silence')
  expect(
    boardWatchDueEvent({
      now: origin + BOARD_WATCH_BUILD_CHECK_MS,
      lastByte: origin + BOARD_WATCH_BUILD_CHECK_MS,
      lastSlow: origin,
      lastBuild: origin,
    }),
  ).toBe('build-check')
  expect(
    boardWatchDueEvent({
      now: origin + BOARD_WATCH_SLOW_INTERVAL_MS,
      lastByte: origin + BOARD_WATCH_SLOW_INTERVAL_MS,
      lastSlow: origin,
      lastBuild: origin + BOARD_WATCH_SLOW_INTERVAL_MS,
    }),
  ).toBe('slow-timer')
  expect(
    boardWatchWaitMs({ now: origin, lastByte: origin, lastSlow: origin, lastBuild: origin }),
  ).toBe(BOARD_WATCH_SILENCE_MS)
})

test('a pull result becomes failed, incomplete, or nothing', () => {
  expect(boardWatchPullEvent({ kind: 'failed', reason: 'offline' }, '5', '9')).toEqual({
    kind: 'pull-failed',
    reason: 'offline',
  })
  expect(boardWatchPullEvent({ kind: 'incomplete' }, '5', '9')).toEqual({ kind: 'pull-incomplete' })
  expect(boardWatchPullEvent({ kind: 'ok' }, '4', '9')).toEqual({ kind: 'pull-incomplete' })
  expect(boardWatchPullEvent({ kind: 'ok' }, '9', '9')).toBeNull()
})
