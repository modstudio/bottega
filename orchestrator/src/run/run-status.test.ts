import { describe, expect, test } from 'bun:test'
import { TERMINAL_RUN_STATUS_SQL } from './run-status.ts'

describe('terminal run statuses', () => {
  /**
   * A query that carries this fragment must prepare against the store, so the rendered list is
   * asserted byte-for-byte: quoted, comma-separated, inside parentheses. This pins the tuple and
   * its order through the one form that reaches SQL.
   */
  test('renders the parenthesized quoted list a run IN test needs', () => {
    expect(TERMINAL_RUN_STATUS_SQL).toBe("('ok','failed','stale','stopped')")
  })
})
