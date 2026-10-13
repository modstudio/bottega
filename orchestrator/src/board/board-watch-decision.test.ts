import { expect, test } from 'bun:test'
import {
  BOARD_WATCH_BACKOFF_BASE_MS,
  BOARD_WATCH_BACKOFF_CAP_MS,
  boardWatchBackoffMs,
  boardWatchShouldPull,
  decideBoardWatch,
  initialBoardWatchState,
} from './board-watch-decision.ts'

const fullJitter = 1

test('missing record API configuration exits', () => {
  const decision = decideBoardWatch(initialBoardWatchState(), { kind: 'unconfigured' }, fullJitter)
  expect(decision.action).toBe('exit')
  expect(decision.reason).toBe('unconfigured')
})

test('a changed build exits', () => {
  const decision = decideBoardWatch(initialBoardWatchState(), { kind: 'build-changed' }, fullJitter)
  expect(decision.action).toBe('exit')
  expect(decision.reason).toBe('newer-build')
})

test('opening a stream stays connected', () => {
  const decision = decideBoardWatch(initialBoardWatchState(), { kind: 'opened' }, fullJitter)
  expect(decision).toMatchObject({ action: 'stay', announce: undefined })
})

test('opening after signed-out announces connected once', () => {
  const signedOut = decideBoardWatch(initialBoardWatchState(), { kind: 'unauthorized' }, fullJitter)
  expect(signedOut.announce).toBe('signed-out')
  const again = decideBoardWatch(signedOut.state, { kind: 'unauthorized' }, fullJitter)
  expect(again.announce).toBeUndefined()
  expect(again.delayMs).toBe(BOARD_WATCH_BACKOFF_CAP_MS)
  const recovered = decideBoardWatch(again.state, { kind: 'opened' }, fullJitter)
  expect(recovered.announce).toBe('connected')
  expect(recovered.state.signedOut).toBe(false)
})

test('silence reconnects with exponential backoff', () => {
  const first = decideBoardWatch(initialBoardWatchState(), { kind: 'silence' }, fullJitter)
  expect(first).toMatchObject({
    action: 'reconnect',
    reason: 'silence',
    delayMs: BOARD_WATCH_BACKOFF_BASE_MS,
  })
  const second = decideBoardWatch(first.state, { kind: 'silence' }, fullJitter)
  expect(second.delayMs).toBe(BOARD_WATCH_BACKOFF_BASE_MS * 2)
})

test('a stream the server ended normally reconnects without delay once, then backs off', () => {
  const first = decideBoardWatch(initialBoardWatchState(), { kind: 'ended-normal' }, fullJitter)
  expect(first).toMatchObject({ action: 'reconnect', reason: 'ended', delayMs: 0 })
  const second = decideBoardWatch(first.state, { kind: 'ended-normal' }, fullJitter)
  expect(second.delayMs).toBe(BOARD_WATCH_BACKOFF_BASE_MS)
})

test('the first event resets backoff so the next normal end is immediate again', () => {
  const ended = decideBoardWatch(initialBoardWatchState(), { kind: 'ended-normal' }, fullJitter)
  const reset = decideBoardWatch(ended.state, { kind: 'first-event' }, fullJitter)
  expect(reset.state).toEqual(initialBoardWatchState())
  const next = decideBoardWatch(reset.state, { kind: 'ended-normal' }, fullJitter)
  expect(next.delayMs).toBe(0)
})

test('a stream error uses backoff', () => {
  const decision = decideBoardWatch(initialBoardWatchState(), { kind: 'ended-error' }, fullJitter)
  expect(decision).toMatchObject({
    action: 'reconnect',
    reason: 'error',
    delayMs: BOARD_WATCH_BACKOFF_BASE_MS,
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
  expect(boardWatchShouldPull({ reason: 'connect', cursor: '9' })).toBe(true)
  expect(boardWatchShouldPull({ reason: 'slow', cursor: '9' })).toBe(true)
  expect(boardWatchShouldPull({ reason: 'event', revision: '10', cursor: '9' })).toBe(true)
  expect(boardWatchShouldPull({ reason: 'event', revision: '9', cursor: '9' })).toBe(false)
  expect(boardWatchShouldPull({ reason: 'event', revision: '8', cursor: '9' })).toBe(false)
})
