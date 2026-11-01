import { beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import {
  boardEscalations,
  markRunNoticesDelivered,
  noticeStatus,
  postNotice,
} from './board-service.ts'

beforeEach(() => fixtureProjectRecordId(db()))

test('run receipts carry their UUID sibling while session receipts leave it NULL', () => {
  const clock = Date.now()
  const runId = newRecordId()
  db()
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,turn,project_record_id)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','implement','sha',1,'proof','running',1,
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run(runId, new Date(clock).toISOString())
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,last_seen)
       VALUES ('receipt-session-reader','claude-code','architect','test','run-fixture',
               (SELECT record_id FROM project ORDER BY name LIMIT 1),'/tmp',NULL,?)`,
    )
    .run(new Date(clock).toISOString())

  const runMessage = postNotice(
    { audience: `run:${runId}`, title: 'Run receipt', body: 'Carries the run UUID.' },
    {},
    clock + 1,
  )
  const sessionMessage = postNotice(
    { audience: 'session:receipt-session-reader', title: 'Session receipt', body: 'No run UUID.' },
    {},
    clock + 2,
  )
  const receipt = db().query(
    'SELECT reader_session,reader_run_record_id FROM board_receipt WHERE message_record_id=?',
  )
  expect(receipt.get(runMessage.recordId)).toEqual({
    reader_session: `run:${runId}`,
    reader_run_record_id: runId,
  })
  expect(receipt.get(sessionMessage.recordId)).toEqual({
    reader_session: 'receipt-session-reader',
    reader_run_record_id: null,
  })
})

test('run receipts stay out of session acknowledgement policy and delivery stamps the sibling', () => {
  const clock = Date.now()
  const runId = newRecordId()
  db()
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,turn,project_record_id)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','implement','sha',1,'proof','running',1,
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run(runId, new Date(clock).toISOString())
  const posted = postNotice(
    {
      audience: `run:${runId}`,
      title: 'Run acknowledgement policy',
      body: 'Run readers do not enter session acknowledgement policy.',
      ackRequired: true,
      purpose: 'request',
      deadlineMs: 1_000,
    },
    {},
    clock,
  )

  expect(noticeStatus(posted.recordId, {}, clock + 1).unacknowledged).toEqual([])
  expect(
    boardEscalations(clock + 1_001).some(
      (row) => row.subject === `board:${posted.number}:run:${runId}`,
    ),
  ).toBe(false)

  db()
    .query('UPDATE board_receipt SET reader_run_record_id=NULL WHERE message_record_id=?')
    .run(posted.recordId)
  markRunNoticesDelivered(runId, [posted.recordId], clock + 2)
  expect(
    db()
      .query('SELECT reader_run_record_id FROM board_receipt WHERE message_record_id=?')
      .get(posted.recordId),
  ).toEqual({ reader_run_record_id: runId })
})

test('board receipt readers do not parse run labels', () => {
  for (const file of ['board-service.ts', 'board-store.ts', 'board-hosted-cache.ts']) {
    const source = readFileSync(resolve(import.meta.dir, file), 'utf8')
    expect(source).not.toMatch(/\^run:\([^\n]+\)\$/)
    expect(source).not.toMatch(/reader_session[^\n]*(?:slice|substring|substr)/)
  }
})
