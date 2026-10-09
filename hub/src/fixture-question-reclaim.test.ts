import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import {
  type FixtureQuestion,
  type FixtureTask,
  fixtureIntervalsWithoutRuns,
  fixtureQuestionsWithoutRuns,
  fixtureTasksToReclaim,
  reclaimFixtureQuestions,
} from './fixture-question-reclaim.ts'

beforeEach(resetFixtureStore)

test('fixture question selection removes only documented sessions whose run is absent', () => {
  const row = (
    question_id: number,
    session_id: string,
    run_ref = `orch:${question_id}`,
  ): FixtureQuestion => ({
    question_id,
    session_id,
    run_ref,
    root_ref: run_ref,
    task_key: 'DEV-3000',
  })
  expect(
    fixtureQuestionsWithoutRuns(
      [
        row(1, 'sess-a'),
        row(2, 'sess-b'),
        row(3, 'sess-old'),
        row(4, 'sess-probe'),
        row(5, 'sess-real'),
        row(6, 'sess-a', 'orch:live'),
      ],
      new Set(['orch:live']),
    ),
  ).toEqual([row(1, 'sess-a'), row(2, 'sess-b'), row(3, 'sess-old'), row(4, 'sess-probe')])
})

test('listed fixture interval with explicit unknown answer is selected (mutation: skip the unknown-run check)', () => {
  expect(
    fixtureIntervalsWithoutRuns(
      [{ id: 1, source: 'orch', ref: 'orch:9103' }],
      new Map([[9103, { id: 9103, status: 'unknown', unknown: true }]]),
    ),
  ).toEqual([{ id: 1, source: 'orch', ref: 'orch:9103' }])
})

test('listed fixture interval with no answer is kept (mutation: treat a missing answer as unknown)', () => {
  expect(
    fixtureIntervalsWithoutRuns([{ id: 1, source: 'orch', ref: 'orch:9103' }], new Map()),
  ).toEqual([])
})

test('listed fixture interval with known run is kept (mutation: select every listed ref)', () => {
  expect(
    fixtureIntervalsWithoutRuns(
      [{ id: 1, source: 'orch', ref: 'orch:9103' }],
      new Map([[9103, { id: 9103, status: 'ok' }]]),
    ),
  ).toEqual([])
})

test('unlisted interval with unknown run is kept (mutation: select any unknown orch interval)', () => {
  expect(
    fixtureIntervalsWithoutRuns(
      [{ id: 1, source: 'orch', ref: 'orch:2072' }],
      new Map([[2072, { id: 2072, status: 'unknown', unknown: true }]]),
    ),
  ).toEqual([])
})

test('turn ref looks up the turn id not the root (mutation: look up parsed.root for turn refs)', () => {
  const interval = { id: 1, source: 'orch' as const, ref: 'orch:9301:turn:9302' }
  expect(
    fixtureIntervalsWithoutRuns(
      [interval],
      new Map([
        [9301, { id: 9301, status: 'ok' }],
        [9302, { id: 9302, status: 'unknown', unknown: true }],
      ]),
    ),
  ).toEqual([interval])
  expect(
    fixtureIntervalsWithoutRuns(
      [interval],
      new Map([
        [9301, { id: 9301, status: 'unknown', unknown: true }],
        [9302, { id: 9302, status: 'ok' }],
      ]),
    ),
  ).toEqual([])
})

const fixtureTask = (overrides: Partial<FixtureTask> = {}): FixtureTask => ({
  record_id: 'fixture-task-record',
  key: 'ALP-899',
  project: 'alpha',
  title: 'No assignment field',
  opened_at: null,
  ...overrides,
})

test('fixture task selection includes an exact unregistered unopened match', () => {
  const row = fixtureTask()
  expect(fixtureTasksToReclaim([row], new Set())).toEqual([row])
})

test('fixture task selection keeps a matching key with a different title', () => {
  expect(fixtureTasksToReclaim([fixtureTask({ title: 'Different title' })], new Set())).toEqual([])
})

test('fixture task selection keeps a task with a non-null opened_at', () => {
  expect(
    fixtureTasksToReclaim([fixtureTask({ opened_at: '2026-09-24T12:00:00.000Z' })], new Set()),
  ).toEqual([])
})

test('fixture task selection keeps a task in a registered project', () => {
  expect(fixtureTasksToReclaim([fixtureTask()], new Set(['alpha']))).toEqual([])
})

test('fixture task reclaim deletes the task and all child rows in one fixture-store transaction', async () => {
  writeTransaction((connection) => {
    connection
      .query(
        `INSERT INTO task
          (record_id,key,project,title,status,status_category,opened_at,updated_at,source,first_seen,last_seen)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'fixture-task-record',
        'ALP-899',
        'alpha',
        'No assignment field',
        null,
        null,
        null,
        null,
        'mcp',
        '',
        '',
      )
    connection
      .query(
        'INSERT INTO task_comment(record_id,task_key,task_record_id,body,created_at) VALUES (?,?,?,?,?)',
      )
      .run('fixture-comment-record', 'ALP-899', 'fixture-task-record', 'comment', '')
    connection
      .query(
        `INSERT INTO task_document(record_id,task_key,task_record_id,number,title,body,version,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'fixture-document-record',
        'ALP-899',
        'fixture-task-record',
        1,
        'document',
        'body',
        'v1',
        '',
        '',
      )
    connection
      .query(
        'INSERT INTO task_status_event(record_id,task_key,task_record_id,at,to_status) VALUES (?,?,?,?,?)',
      )
      .run('fixture-event-record', 'ALP-899', 'fixture-task-record', '', 'open')
  })

  const dryRun = await reclaimFixtureQuestions(true, new Set())

  expect(dryRun.tasks).toEqual([fixtureTask()])
  for (const table of ['task_comment', 'task_document', 'task_status_event', 'task']) {
    expect(db().query(`SELECT * FROM ${table}`).all()).toHaveLength(1)
  }

  const result = await reclaimFixtureQuestions(false, new Set())

  expect(result.tasks).toEqual([fixtureTask()])
  for (const table of ['task_comment', 'task_document', 'task_status_event', 'task']) {
    expect(db().query(`SELECT * FROM ${table}`).all()).toEqual([])
  }
})
