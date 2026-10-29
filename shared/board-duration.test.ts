import { expect, test } from 'bun:test'
import {
  BOARD_DEFAULT_ACK_DEADLINE_MS,
  BOARD_INFORMATION_DEFAULT_EXPIRY_MS,
  BOARD_REQUEST_DEFAULT_EXPIRY_MS,
  BOARD_STANDING_DEFAULT_EXPIRY_MS,
  extendedBoardThreadExpiry,
  parseBoardDuration,
} from './board-duration.ts'

test('board duration grammar and defaults are shared', () => {
  expect(parseBoardDuration('10m')).toBe(600_000)
  expect(parseBoardDuration(' 6h ')).toBe(21_600_000)
  expect(BOARD_DEFAULT_ACK_DEADLINE_MS).toBe(3_600_000)
  expect(BOARD_INFORMATION_DEFAULT_EXPIRY_MS).toBe(14_400_000)
  expect(BOARD_REQUEST_DEFAULT_EXPIRY_MS).toBe(14_400_000)
  expect(BOARD_STANDING_DEFAULT_EXPIRY_MS).toBe(604_800_000)
})

test('a board reply extends its thread from the reply time without moving expiry earlier', () => {
  const replyTime = Date.parse('2026-10-29T12:00:00.000Z')
  expect(extendedBoardThreadExpiry('2026-10-29T13:00:00.000Z', replyTime, 'information')).toBe(
    '2026-10-29T16:00:00.000Z',
  )
  expect(extendedBoardThreadExpiry('2026-11-01T12:00:00.000Z', replyTime, 'request')).toBe(
    '2026-11-01T12:00:00.000Z',
  )
})

test('a board reply uses purpose defaults and leaves an unbounded thread unchanged', () => {
  const replyTime = Date.parse('2026-10-29T12:00:00.000Z')
  const currentExpiry = '2026-10-29T12:01:00.000Z'
  expect(extendedBoardThreadExpiry(currentExpiry, replyTime, 'request')).toBe(
    '2026-10-29T16:00:00.000Z',
  )
  expect(extendedBoardThreadExpiry(currentExpiry, replyTime, 'standing')).toBe(
    '2026-11-05T12:00:00.000Z',
  )
  expect(extendedBoardThreadExpiry(currentExpiry, replyTime, null)).toBe('2026-10-29T16:00:00.000Z')
  expect(extendedBoardThreadExpiry(null, replyTime, 'standing')).toBeNull()
})

test.each(['0m', '-1h', 'soon'])('refuses invalid board duration %s', (value) => {
  expect(() => parseBoardDuration(value)).toThrow(`invalid duration ${value}`)
})

test('refuses a board duration whose milliseconds are not a safe integer', () => {
  const value = `${Number.MAX_SAFE_INTEGER}d`
  expect(() => parseBoardDuration(value)).toThrow(
    `invalid duration ${value}; use a positive value such as 30m or 1d`,
  )
})
