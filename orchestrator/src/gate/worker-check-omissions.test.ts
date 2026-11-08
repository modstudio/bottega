import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  latestFinishedWorkerCheckExecutionRecordId,
  uncheckedChecksForGateExecution,
} from './worker-check-omissions.ts'

function insertGate(input: { runId: string; finishedAt: string }): string {
  const recordId = newRecordId()
  db()
    .query(
      `INSERT INTO gate_execution
        (record_id,run_record_id,requested_at,finished_at,exit_code,timed_out,elapsed_ms,purpose)
       VALUES (?,?,?,?,0,0,1000,'worker-check')`,
    )
    .run(recordId, input.runId, input.finishedAt, input.finishedAt)
  return recordId
}

test('unchecked-check reader returns only omissions ordered by check name', () => {
  const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  const gate = insertGate({ runId: run, finishedAt: '2026-10-01T11:00:00.000Z' })
  const insert = db().query(
    `INSERT INTO check_execution
      (record_id,gate_execution_record_id,check_name,wall_ms,exit_code,unchecked_reason)
     VALUES (?,?,?,?,?,?)`,
  )
  insert.run(newRecordId(), gate, 'typecheck', 0, 0, 'no matching files')
  insert.run(newRecordId(), gate, 'biome', 0, 0, 'no files to check')
  insert.run(newRecordId(), gate, 'tests', 20, 0, null)

  expect(uncheckedChecksForGateExecution(gate, db())).toEqual([
    { check: 'biome', reason: 'no files to check' },
    { check: 'typecheck', reason: 'no matching files' },
  ])
})

test('latest worker-check reader returns the newest finished execution by request order', () => {
  const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
  insertGate({ runId: run, finishedAt: '2026-10-01T10:00:00.000Z' })
  const newestFinished = insertGate({
    runId: run,
    finishedAt: '2026-10-01T11:00:00.000Z',
  })
  db()
    .query(
      `INSERT INTO gate_execution
        (record_id,run_record_id,requested_at,purpose)
       VALUES (?,?,?,'worker-check')`,
    )
    .run(newRecordId(), run, '2026-10-01T12:00:00.000Z')

  expect(latestFinishedWorkerCheckExecutionRecordId(run, db())).toBe(newestFinished)
})
