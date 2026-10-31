// concern: run-test-outcome
/** Derives a run's test outcome from Bottega's tool observations, never the worker's claim. */

import type { Database } from 'bun:sqlite'
import { UNIT_TEST_CHECK_CATEGORY } from '../../../shared/check-execution.ts'
import { readEventLog, runEventsPath } from '../events.ts'
import { hasFocusedTestRunner } from '../focused-test/focused-test-decision.ts'

type TestExecutionObservation = { passed: boolean }
export type FocusedTestExecutionObservation = TestExecutionObservation & {
  paths: readonly string[]
  expect?: 'fail'
}
type GateTestExecutionObservation = TestExecutionObservation & {
  gateExecutionId: string
}
export type GateTestObservations = {
  checks: readonly GateTestExecutionObservation[]
  latestFinishedExecutionId: string | null
}
export type TestOutcomeClaim = { ran?: boolean; passed?: boolean | null } | null | undefined

export type ObservedTestOutcome = {
  ran: boolean | null
  passed: boolean | null
  claimDisagrees: boolean | null
  probesPassed: readonly (readonly string[])[]
}

export function deriveObservedTestOutcome(input: {
  focused: readonly FocusedTestExecutionObservation[]
  gate: GateTestObservations
  claim: TestOutcomeClaim
  focusedRunnerRegistered: boolean
  refusedPaths?: readonly string[]
}): ObservedTestOutcome {
  const probesPassed = input.focused
    .filter((execution) => execution.expect === 'fail' && execution.passed)
    .map((execution) => execution.paths)
  const latestFocused = new Map<string, FocusedTestExecutionObservation>()
  for (const execution of input.focused) {
    if (execution.expect === 'fail') continue
    const pathSet = JSON.stringify([...new Set(execution.paths)].sort())
    latestFocused.set(pathSet, execution)
  }
  const latestGateExecutions = input.gate.checks.filter(
    (execution) => execution.gateExecutionId === input.gate.latestFinishedExecutionId,
  )
  const executions = [...latestFocused.values(), ...latestGateExecutions]
  if (executions.length === 0 && !input.focusedRunnerRegistered) {
    return { ran: null, passed: null, claimDisagrees: null, probesPassed }
  }
  const ran = executions.length > 0
  const passed = input.refusedPaths?.length
    ? null
    : ran
      ? executions.every((execution) => execution.passed)
      : null
  const claimedObservation = input.claim?.ran === true || input.claim?.passed != null
  const claimDisagrees =
    claimedObservation && (!ran || passed === null)
      ? null
      : Boolean(
          input.claim &&
            ((input.claim.ran != null && input.claim.ran !== ran) ||
              (input.claim.passed != null && input.claim.passed !== passed)),
        )
  return { ran, passed, claimDisagrees, probesPassed }
}

export function focusedTestObservations(runId: string): FocusedTestExecutionObservation[] {
  return readEventLog(runEventsPath(runId)).flatMap((event): FocusedTestExecutionObservation[] => {
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
      {
        passed: event.exitCode === 0 && !event.timedOut,
        paths: event.paths,
        ...(event.expect === 'fail' ? { expect: event.expect } : {}),
      },
    ]
  })
}

function probePassedNote(paths: readonly string[]): string {
  return `declared expect-fail run_tests probe passed for ${paths.join(', ')}: the mutation did not bite`
}

/** Append successful mutation-probe findings only to a successful run's outcome note. */
export function outcomeNoteWithPassedProbes(input: {
  status: string
  error: string | null
  probesPassed: readonly (readonly string[])[]
}): string | null {
  if (input.status !== 'ok' || input.probesPassed.length === 0) return input.error
  return [input.error, ...input.probesPassed.map(probePassedNote)].filter(Boolean).join('; ')
}

function focusedTestRefusedPaths(runId: string): string[] {
  return readEventLog(runEventsPath(runId)).flatMap((event): string[] =>
    event.type === 'focused_test_refusal' &&
    Array.isArray(event.paths) &&
    event.paths.every((path): path is string => typeof path === 'string')
      ? event.paths
      : [],
  )
}

function gateTestObservations(database: Database, runId: string): GateTestObservations {
  const latestFinishedExecution = database
    .query<{ record_id: string }, [string, string]>(
      `SELECT DISTINCT g.record_id FROM gate_execution g
       JOIN check_execution c ON c.gate_execution_record_id=g.record_id
       WHERE g.run_record_id=? AND g.finished_at IS NOT NULL AND c.category=?
       ORDER BY g.finished_at DESC,g.record_id DESC LIMIT 1`,
    )
    .get(runId, UNIT_TEST_CHECK_CATEGORY)
  const rows = database
    .query<{ exit_code: number; gate_execution_record_id: string }, [string, string]>(
      `SELECT c.exit_code,c.gate_execution_record_id FROM check_execution c
       JOIN gate_execution g ON g.record_id=c.gate_execution_record_id
       WHERE g.run_record_id=? AND g.finished_at IS NOT NULL AND c.category=?`,
    )
    .all(runId, UNIT_TEST_CHECK_CATEGORY)
  return {
    checks: rows.map((row) => ({
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
    gate,
    claim,
    focusedRunnerRegistered: hasFocusedTestRunner(settings.focusedTests),
    refusedPaths: focusedTestRefusedPaths(runId),
  })
}
