// concern: run-status
/**
 * Owns the shared run-status sets. Imports nothing, so a pure decision
 * module can depend on it without reaching a store, a clock or a process.
 *
 * orchestrator/hooks/score-reminder.py restates this list in Python, which cannot import it: that
 * copy must change with this list.
 */

/** The terminal run statuses, in the order the lifecycle lists them. */
const TERMINAL_RUN_STATUSES = ['ok', 'failed', 'stale', 'stopped'] as const

/** The live run statuses, in lifecycle order. */
export const RUN_LIVE_STATUSES = ['queued', 'reserved', 'attached', 'running', 'asking'] as const

/** The live statuses as the quoted, parenthesized SQL list a run `IN` test needs. */
export const LIVE_RUN_STATUS_SQL = `(${RUN_LIVE_STATUSES.map((status) => `'${status}'`).join(',')})`

/** The same statuses for callers that test whether a recorded run status is terminal. */
export const TERMINAL_RUN_STATUS_SET: ReadonlySet<string> = new Set<string>(TERMINAL_RUN_STATUSES)

/** The same statuses as the quoted, parenthesized SQL list a run `IN` or `NOT IN` test needs. */
export const TERMINAL_RUN_STATUS_SQL = `(${TERMINAL_RUN_STATUSES.map((status) => `'${status}'`).join(',')})`

/** Run statuses whose facts can already be reflected in the hosted record. */
const RECORD_REACHABLE_RUN_STATUSES = [...TERMINAL_RUN_STATUSES, 'asking'] as const

/** The record-reachable statuses for in-process eligibility checks. */
export const RECORD_REACHABLE_RUN_STATUS_SET: ReadonlySet<string> = new Set<string>(
  RECORD_REACHABLE_RUN_STATUSES,
)

/** The record-reachable statuses as the quoted, parenthesized SQL list an `IN` test needs. */
export const RECORD_REACHABLE_RUN_STATUS_SQL = `(${RECORD_REACHABLE_RUN_STATUSES.map((status) => `'${status}'`).join(',')})`
