import { describe, expect, test } from 'bun:test'
import { UNIT_TEST_CHECK_CATEGORY } from '../../../shared/check-execution.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import { deriveObservedTestOutcome, observedTestOutcome } from './run-test-outcome.ts'

describe('deriveObservedTestOutcome', () => {
  test('nothing-run focus and a passing gate that skipped unit tests do not support the claim', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [],
        gate: [],
        latestFinishedGateExecutionId: null,
        claim: { ran: true, passed: true },
        focusedRunnerRegistered: true,
      }),
    ).toEqual({ ran: false, passed: null, claimDisagrees: true })
  })

  test('an executed passing focused run establishes the claimed outcome', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [{ executed: true, passed: true, paths: ['passing.test.ts'] }],
        gate: [],
        latestFinishedGateExecutionId: null,
        claim: { ran: true, passed: true },
        focusedRunnerRegistered: true,
      }),
    ).toEqual({ ran: true, passed: true, claimDisagrees: false })
  })

  test('a passing rerun replaces a failed result for the same path set', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [
          { executed: true, passed: false, paths: ['b.test.ts', 'a.test.ts'] },
          { executed: true, passed: true, paths: ['a.test.ts', 'b.test.ts'] },
        ],
        gate: [],
        latestFinishedGateExecutionId: null,
        claim: { ran: true, passed: true },
        focusedRunnerRegistered: true,
      }),
    ).toEqual({ ran: true, passed: true, claimDisagrees: false })
  })

  test('a failing rerun replaces a passing result for the same path set', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [
          { executed: true, passed: true, paths: ['a.test.ts'] },
          { executed: true, passed: false, paths: ['a.test.ts'] },
        ],
        gate: [],
        latestFinishedGateExecutionId: null,
        claim: null,
        focusedRunnerRegistered: true,
      }),
    ).toEqual({ ran: true, passed: false, claimDisagrees: false })
  })

  test('a passing different path set does not replace an earlier failed path set', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [
          { executed: true, passed: false, paths: ['a.test.ts'] },
          { executed: true, passed: true, paths: ['b.test.ts'] },
        ],
        gate: [],
        latestFinishedGateExecutionId: null,
        claim: null,
        focusedRunnerRegistered: true,
      }),
    ).toEqual({ ran: true, passed: false, claimDisagrees: false })
  })

  test('only unit-test checks from the latest finished gate count', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [],
        gate: [
          {
            executed: true,
            passed: false,
            gateExecutionId: 'earlier',
          },
          {
            executed: true,
            passed: true,
            gateExecutionId: 'latest',
          },
        ],
        latestFinishedGateExecutionId: 'latest',
        claim: { ran: true, passed: true },
        focusedRunnerRegistered: true,
      }),
    ).toEqual({ ran: true, passed: true, claimDisagrees: false })
  })

  test('no tool calls records that no tests ran', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [],
        gate: [],
        latestFinishedGateExecutionId: null,
        claim: null,
        focusedRunnerRegistered: true,
      }),
    ).toEqual({
      ran: false,
      passed: null,
      claimDisagrees: false,
    })
  })

  test('an absent focused runner makes an unobserved worker command non-disagreeing', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [],
        gate: [],
        latestFinishedGateExecutionId: null,
        claim: { ran: true, passed: true },
        focusedRunnerRegistered: false,
      }),
    ).toEqual({ ran: null, passed: null, claimDisagrees: false })
  })

  test('reads only started focused executions and unit-test checks from the run gate', () => {
    const runId = addRun({ agent: 'codex', job: 'implement' })
    appendRunEvent(runId, {
      ts: '2026-10-21T00:00:00.000Z',
      type: 'focused_test',
      paths: ['passing.test.ts'],
      started: true,
      exitCode: 0,
      timedOut: false,
      elapsedMs: 10,
      logName: 'started.log',
      logPath: '/scratch/started.log',
    })
    appendRunEvent(runId, {
      ts: '2026-10-21T00:00:01.000Z',
      type: 'focused_test',
      paths: ['never-started.test.ts'],
      started: false,
      exitCode: -1,
      timedOut: false,
      elapsedMs: 1,
      logName: 'launch-failure.log',
      logPath: '/scratch/launch-failure.log',
    })
    const gateRecordId = db()
      .query<{ record_id: string }, [string, string, string, string, string]>(
        `INSERT INTO gate_execution
            (record_id,run_record_id,requested_at,started_at,finished_at,exit_code)
           VALUES (?,?,?,?,?,1) RETURNING record_id`,
      )
      .get(
        newRecordId(),
        runId,
        '2026-10-21T00:00:02.000Z',
        '2026-10-21T00:00:02.000Z',
        '2026-10-21T00:00:03.000Z',
      )!.record_id
    db()
      .query(
        `INSERT INTO check_execution
          (record_id,gate_execution_record_id,check_name,category,wall_ms,exit_code)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(newRecordId(), gateRecordId, 'unit suite', UNIT_TEST_CHECK_CATEGORY, 100, 1)

    expect(observedTestOutcome(db(), runId, { ran: true, passed: false })).toEqual({
      ran: true,
      passed: false,
      claimDisagrees: false,
    })
  })
})
