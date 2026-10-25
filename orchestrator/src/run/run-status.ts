// concern: run-status
/**
 * Owns the terminal run-status set: the states a run can be left in when its conversation is
 * over, as opposed to the live ones it passes through. Imports nothing, so a pure decision
 * module can depend on it without reaching a store, a clock or a process.
 *
 * orchestrator/hooks/score-reminder.py restates this list in Python, which cannot import it: that
 * copy must change with this list.
 */

/** The terminal run statuses, in the order the lifecycle lists them. */
const TERMINAL_RUN_STATUSES = ['ok', 'failed', 'stale', 'stopped'] as const

/** The same statuses for callers that test whether a recorded run status is terminal. */
export const TERMINAL_RUN_STATUS_SET: ReadonlySet<string> = new Set<string>(TERMINAL_RUN_STATUSES)

/** The same statuses as the quoted, parenthesized SQL list a run `IN` or `NOT IN` test needs. */
export const TERMINAL_RUN_STATUS_SQL = `(${TERMINAL_RUN_STATUSES.map((status) => `'${status}'`).join(',')})`
