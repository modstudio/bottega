// concern: run-test-outcome
/** Derives a run's test outcome from Bottega's tool observations, never the worker's claim. */

import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { UNIT_TEST_CHECK_CATEGORY } from '../../../shared/check-execution.ts'
import { runEventsPath } from '../events.ts'

export type TestExecutionObservation = { executed: true; passed: boolean }
export type TestOutcomeClaim = { ran?: boolean; passed?: boolean | null } | null

export type ObservedTestOutcome = {
  ran: boolean
  passed: boolean | null
  claimDisagrees: boolean
}

export function deriveObservedTestOutcome(input: {
  focused: readonly TestExecutionObservation[]
  gate: readonly TestExecutionObservation[]
  claim: TestOutcomeClaim
}): ObservedTestOutcome {
  const executions = [...input.focused, ...input.gate]
  const ran = executions.length > 0
  const passed = ran ? executions.every((execution) => execution.passed) : null
  const claimDisagrees = Boolean(
    input.claim &&
      ((input.claim.ran != null && input.claim.ran !== ran) ||
        (input.claim.passed != null && input.claim.passed !== passed)),
  )
  return { ran, passed, claimDisagrees }
}

function focusedTestObservations(runId: string): TestExecutionObservation[] {
  const path = runEventsPath(runId)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line): TestExecutionObservation[] => {
      if (!line.trim()) return []
      try {
        const event = JSON.parse(line) as {
          type?: unknown
          started?: unknown
          exitCode?: unknown
          timedOut?: unknown
        }
        if (
          event.type !== 'focused_test' ||
          event.started !== true ||
          typeof event.exitCode !== 'number' ||
          typeof event.timedOut !== 'boolean'
        )
          return []
        return [{ executed: true, passed: event.exitCode === 0 && !event.timedOut }]
      } catch {
        return []
      }
    })
}

function gateTestObservations(database: Database, runId: string): TestExecutionObservation[] {
  const rows = database
    .query<{ exit_code: number }, [string, string]>(
      `SELECT c.exit_code FROM check_execution c
       JOIN gate_execution g ON g.id=c.gate_execution_id
       WHERE g.run_record_id=? AND g.finished_at IS NOT NULL AND c.category=?`,
    )
    .all(runId, UNIT_TEST_CHECK_CATEGORY)
  return rows.map((row) => ({ executed: true, passed: row.exit_code === 0 }))
}

export function observedTestOutcome(
  database: Database,
  runId: string,
  claim: TestOutcomeClaim,
): ObservedTestOutcome {
  return deriveObservedTestOutcome({
    focused: focusedTestObservations(runId),
    gate: gateTestObservations(database, runId),
    claim,
  })
}
