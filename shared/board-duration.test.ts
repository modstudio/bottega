import { expect, test } from 'bun:test'
import {
  BOARD_DEFAULT_ACK_DEADLINE_MS,
  BOARD_DEFAULT_EXPIRY_MS,
  parseBoardDuration,
} from './board-duration.ts'

test('board duration grammar and defaults are shared', () => {
  expect(parseBoardDuration('10m')).toBe(600_000)
  expect(parseBoardDuration(' 6h ')).toBe(21_600_000)
  expect(BOARD_DEFAULT_ACK_DEADLINE_MS).toBe(3_600_000)
  expect(BOARD_DEFAULT_EXPIRY_MS).toBe(86_400_000)
})

test.each(['0m', '-1h', 'soon'])('refuses invalid board duration %s', (value) => {
  expect(() => parseBoardDuration(value)).toThrow(`invalid duration ${value}`)
})
