// concern: run-test-outcome
/** Derives a run's test outcome from Bottega's tool observations, never the worker's claim. */

import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { UNIT_TEST_CHECK_CATEGORY } from '../../../shared/check-execution.ts'
import { runEventsPath } from '../events.ts'
import { hasFocusedTestRunner } from '../focused-test/focused-test-decision.ts'

export type FocusedTestExecutionObservation = {
  executed: true
  passed: boolean
  paths: readonly string[]
}
export type GateTestExecutionObservation = {
  executed: true
  passed: boolean
  gateExecutionId: string
}
export type TestOutcomeClaim = { ran?: boolean; passed?: boolean | null } | null

export type ObservedTestOutcome = {
  ran: boolean | null
  passed: boolean | null
  claimDisagrees: boolean
}

export function deriveObservedTestOutcome(input: {
  focused: readonly FocusedTestExecutionObservation[]
  gate: readonly GateTestExecutionObservation[]
  latestFinishedGateExecutionId: string | null
  claim: TestOutcomeClaim
  focusedRunnerRegistered: boolean
}): ObservedTestOutcome {
  const latestFocused = new Map<string, FocusedTestExecutionObservation>()
  for (const execution of input.focused) {
    const pathSet = JSON.stringify([...new Set(execution.paths)].sort())
    latestFocused.set(pathSet, execution)
  }
  const latestGateExecutions = input.gate.filter(
    (execution) => execution.gateExecutionId === input.latestFinishedGateExecutionId,
  )
  const executions = [...latestFocused.values(), ...latestGateExecutions]
  if (executions.length === 0 && !input.focusedRunnerRegistered) {
    return { ran: null, passed: null, claimDisagrees: false }
  }
  const ran = executions.length > 0
  const passed = ran ? executions.every((execution) => execution.passed) : null
  const claimDisagrees = Boolean(
    input.claim &&
      ((input.claim.ran != null && input.claim.ran !== ran) ||
        (input.claim.passed != null && input.claim.passed !== passed)),
  )
  return { ran, passed, claimDisagrees }
}

function focusedTestObservations(runId: string): FocusedTestExecutionObservation[] {
  const path = runEventsPath(runId)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line): FocusedTestExecutionObservation[] => {
      if (!line.trim()) return []
      try {
        const event = JSON.parse(line) as {
          type?: unknown
          started?: unknown
          paths?: unknown
          exitCode?: unknown
          timedOut?: unknown
        }
        if (
          event.type !== 'focused_test' ||
          event.started !== true ||
          !Array.isArray(event.paths) ||
          !event.paths.every((path): path is string => typeof path === 'string') ||
          typeof event.exitCode !== 'number' ||
          typeof event.timedOut !== 'boolean'
        )
          return []
        return [
          { executed: true, passed: event.exitCode === 0 && !event.timedOut, paths: event.paths },
        ]
      } catch {
        return []
      }
    })
}

function gateTestObservations(
  database: Database,
  runId: string,
): {
  checks: GateTestExecutionObservation[]
  latestFinishedExecutionId: string | null
} {
  const latestFinishedExecution = database
    .query<{ record_id: string }, [string]>(
      `SELECT record_id FROM gate_execution
       WHERE run_record_id=? AND finished_at IS NOT NULL
       ORDER BY finished_at DESC,record_id DESC LIMIT 1`,
    )
    .get(runId)
  const rows = database
    .query<{ exit_code: number; gate_execution_record_id: string }, [string, string]>(
      `SELECT c.exit_code,c.gate_execution_record_id FROM check_execution c
       JOIN gate_execution g ON g.record_id=c.gate_execution_record_id
       WHERE g.run_record_id=? AND g.finished_at IS NOT NULL AND c.category=?`,
    )
    .all(runId, UNIT_TEST_CHECK_CATEGORY)
  return {
    checks: rows.map((row) => ({
      executed: true,
      passed: row.exit_code === 0,
      gateExecutionId: row.gate_execution_record_id,
    })),
    latestFinishedExecutionId: latestFinishedExecution?.record_id ?? null,
  }
}

export function observedTestOutcome(
  database: Database,
  runId: string,
  claim: TestOutcomeClaim,
): ObservedTestOutcome {
  const project = database
    .query<{ settings: string | null }, [string]>(
      `SELECT p.settings FROM run r JOIN project p ON p.record_id=r.project_record_id
       WHERE r.record_id=?`,
    )
    .get(runId)
  const settings = JSON.parse(project?.settings ?? '{}') as { focusedTests?: unknown }
  const gate = gateTestObservations(database, runId)
  return deriveObservedTestOutcome({
    focused: focusedTestObservations(runId),
    gate: gate.checks,
    latestFinishedGateExecutionId: gate.latestFinishedExecutionId,
    claim,
    focusedRunnerRegistered: hasFocusedTestRunner(settings.focusedTests),
  })
}
