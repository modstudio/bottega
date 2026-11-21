import { expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { recordedWorkerCheckResult } from './worker-check-result.ts'

test('recorded worker-check verdict reads failing legs and their persisted footer tails', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const gateId = newRecordId()
  const head = '1234567890abcdef1234567890abcdef12345678'
  const artifact = join(dir, 'worker-check-gate.log')
  writeFileSync(
    artifact,
    [
      '[orchestrator] failing leg tail (exit 2)',
      '[orchestrator] src/example.test.ts(79,5): error TS2322',
      'later checks push this detail out of the bounded tail',
      'gate failures:',
      'orchestrator',
    ].join('\n'),
  )
  db()
    .query(
      `INSERT INTO gate_execution
        (record_id,run_record_id,requested_at,finished_at,exit_code,timed_out,elapsed_ms,purpose,head_commit,output_tail,output_artifact)
       VALUES (?,?,?,?,1,0,20,'worker-check',?,?,?)`,
    )
    .run(
      gateId,
      runId,
      '2026-11-20T10:00:00.000Z',
      '2026-11-20T10:00:01.000Z',
      head,
      ['gate failures:', 'orchestrator'].join('\n'),
      artifact,
    )
  db()
    .query(
      `INSERT INTO check_execution
        (record_id,gate_execution_record_id,check_name,wall_ms,exit_code)
       VALUES (?,?,?,?,?)`,
    )
    .run(newRecordId(), gateId, 'orchestrator', 20, 2)

  expect(recordedWorkerCheckResult(db(), runId, head, null).verdict).toMatchObject({
    kind: 'failed',
    replyHead: head,
    failures: [
      { leg: 'orchestrator', tail: ['[orchestrator] src/example.test.ts(79,5): error TS2322'] },
    ],
  })
  rmSync(artifact)
})

test('recorded worker-check verdict matches a dirty check by reply tree', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const gateId = newRecordId()
  const tree = 'a'.repeat(40)
  db()
    .query(
      `INSERT INTO gate_execution
        (record_id,run_record_id,requested_at,finished_at,exit_code,timed_out,elapsed_ms,purpose,head_commit,tree_id,output_tail)
       VALUES (?,?,?,?,1,0,20,'worker-check',NULL,?,?)`,
    )
    .run(
      gateId,
      runId,
      '2026-11-20T10:00:00.000Z',
      '2026-11-20T10:00:01.000Z',
      tree,
      ['gate failures:', 'orchestrator'].join('\n'),
    )
  db()
    .query(
      `INSERT INTO check_execution
        (record_id,gate_execution_record_id,check_name,wall_ms,exit_code)
       VALUES (?,?,?,?,?)`,
    )
    .run(newRecordId(), gateId, 'orchestrator', 20, 1)

  expect(recordedWorkerCheckResult(db(), runId, 'b'.repeat(40), tree).verdict).toMatchObject({
    kind: 'failed',
    failures: [{ leg: 'orchestrator' }],
  })
})

test('a newer check at other content does not mask an older failed check at the reply', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const replyHead = 'c'.repeat(40)
  const failedGate = newRecordId()
  const insert = db().query(
    `INSERT INTO gate_execution
      (record_id,run_record_id,requested_at,finished_at,exit_code,timed_out,elapsed_ms,purpose,head_commit,output_tail)
     VALUES (?,?,?,?,?,0,20,'worker-check',?,?)`,
  )
  insert.run(
    failedGate,
    runId,
    '2026-11-20T10:00:00.000Z',
    '2026-11-20T10:00:01.000Z',
    1,
    replyHead,
    ['gate failures:', 'orchestrator'].join('\n'),
  )
  insert.run(
    newRecordId(),
    runId,
    '2026-11-20T11:00:00.000Z',
    '2026-11-20T11:00:01.000Z',
    0,
    'd'.repeat(40),
    '',
  )
  db()
    .query(
      `INSERT INTO check_execution
        (record_id,gate_execution_record_id,check_name,wall_ms,exit_code)
       VALUES (?,?,?,?,?)`,
    )
    .run(newRecordId(), failedGate, 'orchestrator', 20, 1)

  const result = recordedWorkerCheckResult(db(), runId, replyHead, null)
  expect(result.execution?.record_id).toBe(failedGate)
  expect(result.verdict.kind).toBe('failed')
})

test('a cancelled matching check does not replace the newest uncancelled verdict', () => {
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const replyHead = 'e'.repeat(40)
  const passingGate = newRecordId()
  const insert = db().query(
    `INSERT INTO gate_execution
      (record_id,run_record_id,requested_at,finished_at,exit_code,timed_out,elapsed_ms,purpose,head_commit,cancelled_reason)
     VALUES (?,?,?,?,?,0,20,'worker-check',?,?)`,
  )
  insert.run(
    passingGate,
    runId,
    '2026-11-20T10:00:00.000Z',
    '2026-11-20T10:00:01.000Z',
    0,
    replyHead,
    null,
  )
  insert.run(
    newRecordId(),
    runId,
    '2026-11-20T11:00:00.000Z',
    '2026-11-20T11:00:01.000Z',
    -1,
    replyHead,
    'coordinator cancelled',
  )

  const result = recordedWorkerCheckResult(db(), runId, replyHead, null)
  expect(result.execution?.record_id).toBe(passingGate)
  expect(result.verdict.kind).toBe('passed')
})
