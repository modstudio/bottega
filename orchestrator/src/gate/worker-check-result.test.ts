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
