import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  WORKER_NOTE_SILENCE_WINDOW_MS,
  type WorkerNoteSilenceFacts,
  workerNoteSilenceCondition,
  workerNoteSilenceConditions,
} from './worker-note-silence-conditions.ts'

const clock = new Date('2026-10-31T20:00:00.000Z').getTime()
const refused: WorkerNoteSilenceFacts = {
  refusalCount: 3,
  filedCount: 0,
  latestRefusalClass: 'filing-refused',
  latestRefusalDetail: 'anchor schema mismatch',
  latestRefusalAt: '2026-10-31T19:00:00.000Z',
}

test('refusals with no filing report worker-note silence', () => {
  expect(workerNoteSilenceCondition(refused, clock)).toMatchObject({
    kind: 'worker-note-silence',
    detail: expect.stringContaining('3 worker note request(s)'),
    action: expect.stringContaining('note new'),
  })
})

test('one filing suppresses worker-note silence', () => {
  expect(workerNoteSilenceCondition({ ...refused, filedCount: 1 }, clock)).toBeNull()
})

test('no requests do not report worker-note silence', () => {
  expect(
    workerNoteSilenceCondition(
      {
        refusalCount: 0,
        filedCount: 0,
        latestRefusalClass: null,
        latestRefusalDetail: null,
        latestRefusalAt: null,
      },
      clock,
    ),
  ).toBeNull()
})

test('refusals outside the observation window are ignored', () => {
  expect(
    workerNoteSilenceCondition(
      {
        ...refused,
        latestRefusalAt: new Date(clock - WORKER_NOTE_SILENCE_WINDOW_MS - 1).toISOString(),
      },
      clock,
    ),
  ).toBeNull()
})

test('worker note silence reader observes only requests inside the window', () => {
  const database = db()
  const runId = addRun({ agent: 'codex', job: 'implement' })
  const insideWindow = new Date(clock - 60_000).toISOString()
  const outsideWindow = new Date(clock - WORKER_NOTE_SILENCE_WINDOW_MS - 1).toISOString()
  const insertRefusal = database.query(
    `INSERT INTO worker_note_request
       (record_id,run_record_id,text,requested_at,finished_at,status,refusal_class,detail)
     VALUES (?,?,?, ?,?,'refused','anchor-refused','anchor schema mismatch')`,
  )

  insertRefusal.run(newRecordId(), runId, 'inside refusal', insideWindow, insideWindow)
  expect(workerNoteSilenceConditions(database, clock)).toEqual([
    expect.objectContaining({
      kind: 'worker-note-silence',
      subject: 'worker-note-request',
      detail: expect.stringContaining('anchor-refused: anchor schema mismatch'),
    }),
  ])

  database
    .query(
      `INSERT INTO worker_note_request
         (record_id,run_record_id,text,requested_at,finished_at,status,note_label)
       VALUES (?,?,?, ?,?,'filed','workshop#1')`,
    )
    .run(newRecordId(), runId, 'inside filing', insideWindow, insideWindow)
  expect(workerNoteSilenceConditions(database, clock)).toEqual([])

  database.query(`DELETE FROM worker_note_request WHERE run_record_id=?`).run(runId)
  insertRefusal.run(newRecordId(), runId, 'old refusal', outsideWindow, outsideWindow)
  expect(workerNoteSilenceConditions(database, clock)).toEqual([])
})
