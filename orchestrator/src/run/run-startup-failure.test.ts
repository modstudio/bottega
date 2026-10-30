import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import {
  recordNeverStartedRunFailure,
  recordRunFinishFailure,
  recordRunStartupFailure,
} from './run-startup-failure.ts'
import { finishRunWithFallback } from './run-terminal-fallback.ts'

test('a finish failure terminalises and publishes a non-terminal run', () => {
  const id = addRun({ agent: 'codex', job: 'review-lens', status: 'asking' })

  recordRunFinishFailure({
    runId: id,
    error: new Error('machine identity lookup broke'),
    started: Date.now() - 25,
    machineId: 'machine-finish-fallback',
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

test.each(['ok', 'stopped'])('a finish failure leaves a %s run unchanged', (status) => {
  const id = addRun({ agent: 'codex', job: 'review-lens', status })

  recordRunFinishFailure({
    runId: id,
    error: 'late finish failure',
    started: Date.now(),
    machineId: 'machine-finish-fallback',
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

test('a refusal after detach keeps the printed run queryable as failed', () => {
  const id = addRun({ agent: '(pending)', job: 'review-lens', status: 'running' })

  recordRunStartupFailure(id, new Error('selected transport refused the launch'))

  expect(
    db().query('SELECT status, failure_kind, error, latency_ms FROM run WHERE record_id=?').get(id),
  ).toEqual({
    status: 'failed',
    failure_kind: 'harness',
    error: 'selected transport refused the launch',
    latency_ms: 0,
  })
  expect(db().query("SELECT kind FROM outbox WHERE row_id=? AND kind='run'").get(id)).toEqual({
    kind: 'run',
  })
})

test('a failed reserved continuation rolls its outcome up to the chain root', () => {
  const root = addRun({ agent: 'codex', job: 'review-lens', status: 'asking' })
  const turn = addRun({
    agent: '(pending)',
    job: 'review-lens',
    status: 'running',
    parent: root,
    turn: 2,
  })

  recordRunStartupFailure(turn, 'continuation setup failed')

  expect(
    db().query('SELECT status, failure_kind, error FROM run WHERE record_id=?').get(root),
  ).toEqual({
    status: 'failed',
    failure_kind: 'harness',
    error: 'continuation setup failed',
  })
  expect(
    db()
      .query("SELECT row_id FROM outbox WHERE row_id IN (?,?) AND kind='run' ORDER BY row_id")
      .all(root, turn),
  ).toEqual([{ row_id: root }, { row_id: turn }].sort((a, b) => a.row_id.localeCompare(b.row_id)))
})

test('a post-claim startup failure records elapsed latency', () => {
  const id = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })

  recordRunStartupFailure(id, 'worker-home setup failed', Date.now() - 25)

  const row = db().query('SELECT status, latency_ms FROM run WHERE record_id=?').get(id) as {
    status: string
    latency_ms: number
  }
  expect(row.status).toBe('failed')
  expect(row.latency_ms).toBeGreaterThanOrEqual(20)
})

test('a never-started failure is inserted and published atomically', () => {
  const id = newRecordId()
  const projectId = newRecordId()
  upsertProject({ recordId: projectId, name: 'never-started', path: '/tmp/caller' })

  recordNeverStartedRunFailure({
    recordId: id,
    error: new Error('canon pack exceeded its budget'),
    job: 'understand',
    repo: null,
    projectRecordId: projectId,
    taskRecordId: null,
    probe: false,
    cwd: '/tmp/caller',
    promptSha: 'prompt-sha',
    specSha: 'spec-sha',
    promptBytes: 12,
    promptHead: 'inspect this',
    sessionId: null,
    mcp: 0,
    startedByUserId: null,
    agentExplicit: 0,
    executor: 'external',
  })

  expect(
    db().query('SELECT status, failure_kind, error FROM run WHERE record_id=?').get(id),
  ).toEqual({
    status: 'failed',
    failure_kind: 'harness',
    error: 'canon pack exceeded its budget',
  })
  expect(db().query("SELECT row_id FROM outbox WHERE row_id=? AND kind='run'").get(id)).toEqual({
    row_id: id,
  })
})

test('a never-started failure insert rolls back when publication fails', () => {
  const id = newRecordId()
  const projectId = newRecordId()
  upsertProject({ recordId: projectId, name: 'never-started-rollback', path: '/tmp/caller' })
  db().exec(
    `CREATE TEMP TRIGGER refuse_run_outbox BEFORE INSERT ON outbox
     WHEN NEW.row_id = '${id}' BEGIN SELECT RAISE(ABORT, 'publication refused'); END`,
  )

  expect(() =>
    recordNeverStartedRunFailure({
      recordId: id,
      error: 'canon pack could not compile',
      job: 'understand',
      repo: null,
      projectRecordId: projectId,
      taskRecordId: null,
      probe: false,
      cwd: '/tmp/caller',
      promptSha: 'prompt-sha',
      specSha: 'spec-sha',
      promptBytes: 12,
      promptHead: 'inspect this',
      sessionId: null,
      mcp: 0,
      startedByUserId: null,
      agentExplicit: 0,
      executor: 'external',
    }),
  ).toThrow('publication refused')
  expect(db().query('SELECT 1 FROM run WHERE record_id=?').get(id)).toBeNull()
})

test('a never-started probe without a task or project keeps its probe flag', () => {
  const id = newRecordId()

  recordNeverStartedRunFailure({
    recordId: id,
    error: new Error('probe canon pack could not compile'),
    job: 'understand',
    repo: null,
    projectRecordId: null,
    taskRecordId: null,
    probe: true,
    cwd: '/tmp/probe-caller',
    promptSha: 'prompt-sha',
    specSha: 'spec-sha',
    promptBytes: 12,
    promptHead: 'inspect this',
    sessionId: null,
    mcp: 0,
    startedByUserId: null,
    agentExplicit: 0,
    executor: 'external',
  })

  expect(db().query('SELECT probe FROM run WHERE record_id=?').get(id)).toEqual({ probe: 1 })
})
