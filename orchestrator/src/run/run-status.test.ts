import { describe, expect, test } from 'bun:test'
import {
  TERMINAL_RUN_STATUS_SET,
  TERMINAL_RUN_STATUS_SQL,
  TERMINAL_RUN_STATUSES,
} from './run-status.ts'

describe('terminal run statuses', () => {
  test('lists the statuses a finished conversation can be left in', () => {
    expect([...TERMINAL_RUN_STATUSES]).toEqual(['ok', 'failed', 'stale', 'stopped'])
  })

  test('answers membership for a terminal status and for a live one', () => {
    for (const status of TERMINAL_RUN_STATUSES)
      expect(TERMINAL_RUN_STATUS_SET.has(status)).toBe(true)
    for (const status of ['reserved', 'attached', 'running', 'asking', 'unknown', ''])
      expect(TERMINAL_RUN_STATUS_SET.has(status)).toBe(false)
  })

  /**
   * A query that carries this fragment must prepare against the store, so the rendered list is
   * asserted byte-for-byte: quoted, comma-separated, inside parentheses.
   */
  test('renders the parenthesized quoted list a run IN test needs', () => {
    expect(TERMINAL_RUN_STATUS_SQL).toBe("('ok','failed','stale','stopped')")
  })
})
