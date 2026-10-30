import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { markTerminalRecorded } from './run-finish-error.ts'
import { recordRunFinishFailure, shouldWriteFinishFailure } from './run-finish-failure.ts'
import { finishRunWithFallback } from './run-terminal-fallback.ts'

test('a finish failure replaces only a non-terminal run status', () => {
  expect(shouldWriteFinishFailure('running', false)).toBe(true)
  expect(shouldWriteFinishFailure('asking', false)).toBe(true)
  expect(shouldWriteFinishFailure('asking', true)).toBe(false)
  expect(shouldWriteFinishFailure('ok', false)).toBe(false)
  expect(shouldWriteFinishFailure('failed', false)).toBe(false)
  expect(shouldWriteFinishFailure('stale', false)).toBe(false)
  expect(shouldWriteFinishFailure('stopped', false)).toBe(false)
})

test('a finish failure terminalises and publishes a non-terminal run', () => {
  const id = addRun({ agent: 'codex', job: 'review-lens', status: 'asking' })

  recordRunFinishFailure({
    runId: id,
    error: new Error('machine identity lookup broke'),
    started: Date.now() - 25,
    machineId: 'machine-finish-fallback',
    terminalRecorded: false,
  })

  expect(
    db().query('SELECT status, failure_kind, error FROM run WHERE record_id=?').get(id),
  ).toEqual({
    status: 'failed',
    failure_kind: 'harness',
    error: 'finish failed: machine identity lookup broke',
  })
  expect(db().query("SELECT kind FROM outbox WHERE row_id=? AND kind='run'").get(id)).toEqual({
    kind: 'run',
  })
})

test('a finish input builder failure terminalises and publishes the run', async () => {
  const id = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })

  await expect(
    finishRunWithFallback(
      () => {
        throw new Error('checkpoint preparation broke')
      },
      {
        runId: id,
        started: Date.now() - 25,
        machineId: 'machine-finish-fallback',
      },
    ),
  ).rejects.toMatchObject({ message: 'checkpoint preparation broke', runFinishFailed: true })

  expect(
    db().query('SELECT status, failure_kind, error FROM run WHERE record_id=?').get(id),
  ).toEqual({
    status: 'failed',
    failure_kind: 'harness',
    error: 'finish failed: checkpoint preparation broke',
  })
  expect(db().query("SELECT kind FROM outbox WHERE row_id=? AND kind='run'").get(id)).toEqual({
    kind: 'run',
  })
})

test('a finish failure closes a child question and rolls failure up to the root', () => {
  const root = addRun({ agent: 'codex', job: 'review-lens', status: 'asking' })
  const turn = addRun({
    agent: 'codex',
    job: 'review-lens',
    status: 'asking',
    parent: root,
    turn: 2,
  })
  const questionId = newRecordId()
  db()
    .query(
      `INSERT INTO question (record_id,number,run_record_id,asked_at,question)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM question),?,'2026-10-30','Which path?')`,
    )
    .run(questionId, turn)

  recordRunFinishFailure({
    runId: turn,
    error: new Error('terminal persistence broke'),
    started: Date.now() - 25,
    machineId: 'machine-finish-fallback',
    terminalRecorded: false,
  })

  expect(
    db().query('SELECT status, failure_kind, error FROM run WHERE record_id=?').get(root),
  ).toEqual({
    status: 'failed',
    failure_kind: 'harness',
    error: 'finish failed: terminal persistence broke',
  })
  expect(db().query('SELECT close_reason FROM question WHERE record_id=?').get(questionId)).toEqual(
    {
      close_reason: 'chain-terminal',
    },
  )
  expect(
    db()
      .query("SELECT row_id FROM outbox WHERE row_id IN (?,?) AND kind='run' ORDER BY row_id")
      .all(root, turn),
  ).toEqual([{ row_id: root }, { row_id: turn }].sort((a, b) => a.row_id.localeCompare(b.row_id)))
})

test('a terminal-recorded finish error leaves an asking row and question open', async () => {
  const id = addRun({ agent: 'codex', job: 'review-lens', status: 'asking' })
  const questionId = newRecordId()
  db()
    .query(
      `INSERT INTO question (record_id,number,run_record_id,asked_at,question)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM question),?,'2026-10-30','Still open?')`,
    )
    .run(questionId, id)

  await expect(
    finishRunWithFallback(
      () => {
        throw markTerminalRecorded(new Error('resource teardown broke'))
      },
      { runId: id, started: Date.now() - 25, machineId: 'machine-finish-fallback' },
    ),
  ).rejects.toMatchObject({ message: 'resource teardown broke', runFinishFailed: true })

  expect(db().query('SELECT status FROM run WHERE record_id=?').get(id)).toEqual({
    status: 'asking',
  })
  expect(db().query('SELECT closed_at FROM question WHERE record_id=?').get(questionId)).toEqual({
    closed_at: null,
  })
})

test.each(['ok', 'stopped'])('a finish failure leaves a %s run unchanged', (status) => {
  const id = addRun({ agent: 'codex', job: 'review-lens', status })

  recordRunFinishFailure({
    runId: id,
    error: 'late finish failure',
    started: Date.now(),
    machineId: 'machine-finish-fallback',
    terminalRecorded: false,
  })

  expect(
    db().query('SELECT status, failure_kind, error FROM run WHERE record_id=?').get(id),
  ).toEqual({
    status,
    failure_kind: null,
    error: null,
  })
  expect(db().query("SELECT kind FROM outbox WHERE row_id=? AND kind='run'").get(id)).toBeNull()
})
