import { describe, expect, test } from 'bun:test'
import { UNIT_TEST_CHECK_CATEGORY } from '../../../shared/check-execution.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import {
  deriveObservedTestOutcome,
  observedTestOutcome,
  outcomeNoteWithPassedProbes,
} from './run-test-outcome.ts'

describe('deriveObservedTestOutcome', () => {
  test('nothing-run focus and a passing gate that skipped unit tests do not support the claim', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [],
        gate: { checks: [], latestFinishedExecutionId: null },
        claim: { ran: true, passed: true },
        focusedRunnerRegistered: true,
      }),
    ).toEqual({ ran: false, passed: null, claimDisagrees: null, probesPassed: [] })
  })

  test('an executed passing focused run establishes the claimed outcome', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [{ passed: true, paths: ['passing.test.ts'] }],
        gate: { checks: [], latestFinishedExecutionId: null },
        claim: { ran: true, passed: true },
        focusedRunnerRegistered: true,
      }),
    ).toEqual({ ran: true, passed: true, claimDisagrees: false, probesPassed: [] })
  })

  test('an observed failed execution contradicts a passing claim', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [{ passed: false, paths: ['failing.test.ts'] }],
        gate: { checks: [], latestFinishedExecutionId: null },
        claim: { ran: true, passed: true },
        focusedRunnerRegistered: true,
      }),
    ).toEqual({ ran: true, passed: false, claimDisagrees: true, probesPassed: [] })
  })

  test('a passing rerun replaces a failed result for the same path set', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [
          { passed: false, paths: ['b.test.ts', 'a.test.ts'] },
          { passed: true, paths: ['a.test.ts', 'b.test.ts'] },
        ],
        gate: { checks: [], latestFinishedExecutionId: null },
        claim: { ran: true, passed: true },
        focusedRunnerRegistered: true,
      }),
    ).toEqual({ ran: true, passed: true, claimDisagrees: false, probesPassed: [] })
  })

  test('a failing rerun replaces a passing result for the same path set', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [
          { passed: true, paths: ['a.test.ts'] },
          { passed: false, paths: ['a.test.ts'] },
        ],
        gate: { checks: [], latestFinishedExecutionId: null },
        claim: null,
        focusedRunnerRegistered: true,
      }),
    ).toEqual({ ran: true, passed: false, claimDisagrees: false, probesPassed: [] })
  })

  test('a passing different path set does not replace an earlier failed path set', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [
          { passed: false, paths: ['a.test.ts'] },
          { passed: true, paths: ['b.test.ts'] },
        ],
        gate: { checks: [], latestFinishedExecutionId: null },
        claim: null,
        focusedRunnerRegistered: true,
      }),
    ).toEqual({ ran: true, passed: false, claimDisagrees: false, probesPassed: [] })
  })

  test('only unit-test checks from the latest finished gate count', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [],
        gate: {
          checks: [
            { passed: false, gateExecutionId: 'earlier' },
            { passed: true, gateExecutionId: 'latest' },
          ],
          latestFinishedExecutionId: 'latest',
        },
        claim: { ran: true, passed: true },
        focusedRunnerRegistered: true,
      }),
    ).toEqual({ ran: true, passed: true, claimDisagrees: false, probesPassed: [] })
  })

  test('no tool calls records that no tests ran', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [],
        gate: { checks: [], latestFinishedExecutionId: null },
        claim: null,
        focusedRunnerRegistered: true,
      }),
    ).toEqual({
      ran: false,
      passed: null,
      claimDisagrees: false,
      probesPassed: [],
    })
  })

  test('an absent focused runner leaves an unobserved worker claim unverified', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [],
        gate: { checks: [], latestFinishedExecutionId: null },
        claim: { ran: true, passed: true },
        focusedRunnerRegistered: false,
      }),
    ).toEqual({ ran: null, passed: null, claimDisagrees: null, probesPassed: [] })
  })

  test('a refused path makes an otherwise passing observation unverified', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [{ passed: true, paths: ['passing.test.ts'] }],
        gate: { checks: [], latestFinishedExecutionId: null },
        claim: { ran: true, passed: true },
        focusedRunnerRegistered: true,
        refusedPaths: ['unmatched.test.ts'],
      }),
    ).toEqual({ ran: true, passed: null, claimDisagrees: null, probesPassed: [] })
  })

  test('a declared failing probe does not replace the final passing suite on the same paths', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [
          { passed: false, paths: ['subject.test.ts'], expect: 'fail' },
          { passed: true, paths: ['subject.test.ts'] },
        ],
        gate: { checks: [], latestFinishedExecutionId: null },
        claim: { ran: true, passed: true },
        focusedRunnerRegistered: true,
      }),
    ).toEqual({ ran: true, passed: true, claimDisagrees: false, probesPassed: [] })
  })

  test('a declared passing probe is a finding while ordinary calls decide the outcome', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [
          { passed: true, paths: ['mutation.test.ts'], expect: 'fail' },
          { passed: false, paths: ['suite.test.ts'] },
        ],
        gate: { checks: [], latestFinishedExecutionId: null },
        claim: { ran: true, passed: false },
        focusedRunnerRegistered: true,
      }),
    ).toEqual({
      ran: true,
      passed: false,
      claimDisagrees: false,
      probesPassed: [['mutation.test.ts']],
    })
  })

  test('only declared failing probes leave the test outcome not observed', () => {
    expect(
      deriveObservedTestOutcome({
        focused: [
          { passed: false, paths: ['one.test.ts'], expect: 'fail' },
          { passed: false, paths: ['two.test.ts'], expect: 'fail' },
        ],
        gate: { checks: [], latestFinishedExecutionId: null },
        claim: { ran: true, passed: true },
        focusedRunnerRegistered: true,
      }),
    ).toEqual({ ran: false, passed: null, claimDisagrees: null, probesPassed: [] })
  })

  test('passed-probe notes append to successful outcomes and never replace failures', () => {
    expect(
      outcomeNoteWithPassedProbes({
        status: 'ok',
        error: 'existing note',
        probesPassed: [['one.test.ts'], ['two.test.ts', 'three.test.ts']],
      }),
    ).toBe(
      'existing note; declared expect-fail run_tests probe passed for one.test.ts: the mutation did not bite; ' +
        'declared expect-fail run_tests probe passed for two.test.ts, three.test.ts: the mutation did not bite',
    )
    expect(
      outcomeNoteWithPassedProbes({
        status: 'failed',
        error: 'failure owns this error',
        probesPassed: [['one.test.ts']],
      }),
    ).toBe('failure owns this error')
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
      probesPassed: [],
    })
  })

  test('reads a focused test refusal event as an unverified passing observation', () => {
    const runId = addRun({ agent: 'codex', job: 'implement' })
    appendRunEvent(runId, {
      ts: '2026-10-21T00:00:00.000Z',
      type: 'focused_test',
      paths: ['passing.test.ts'],
      started: true,
      exitCode: 0,
      timedOut: false,
      elapsedMs: 10,
      logName: 'passing.log',
      logPath: '/scratch/passing.log',
    })
    appendRunEvent(runId, {
      ts: '2026-10-21T00:00:01.000Z',
      type: 'focused_test_refusal',
      paths: ['unmatched.test.ts'],
    })

    expect(observedTestOutcome(db(), runId, { ran: true, passed: true })).toEqual({
      ran: true,
      passed: null,
      claimDisagrees: null,
      probesPassed: [],
    })
  })

  test('a later cancelled gate without unit-test checks does not replace a completed gate', () => {
    const runId = addRun({ agent: 'codex', job: 'implement' })
    const completedGateRecordId = db()
      .query<{ record_id: string }, [string, string, string, string, string]>(
        `INSERT INTO gate_execution
            (record_id,run_record_id,requested_at,started_at,finished_at,exit_code)
           VALUES (?,?,?,?,?,1) RETURNING record_id`,
      )
      .get(
        newRecordId(),
        runId,
        '2026-10-21T00:00:00.000Z',
        '2026-10-21T00:00:00.000Z',
        '2026-10-21T00:00:01.000Z',
      )!.record_id
    db()
      .query(
        `INSERT INTO check_execution
          (record_id,gate_execution_record_id,check_name,category,wall_ms,exit_code)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(newRecordId(), completedGateRecordId, 'unit suite', UNIT_TEST_CHECK_CATEGORY, 100, 1)
    db()
      .query(
        `INSERT INTO gate_execution
          (record_id,run_record_id,requested_at,finished_at,cancelled_reason)
         VALUES (?,?,?,?,?)`,
      )
      .run(
        newRecordId(),
        runId,
        '2026-10-21T00:00:02.000Z',
        '2026-10-21T00:00:03.000Z',
        'broker closed',
      )

    expect(observedTestOutcome(db(), runId, { ran: true, passed: false })).toEqual({
      ran: true,
      passed: false,
      claimDisagrees: false,
      probesPassed: [],
    })
  })
})
