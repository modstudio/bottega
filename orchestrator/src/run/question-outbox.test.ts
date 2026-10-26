import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { writeTransaction } from '../database/db.ts'
import { fixtureProjectRecordId, migratedTestDatabase } from '../database/test-database.fixture.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from '../record/outbox-payload-contracts.ts'
import { WITHHELD_SECRET_SHAPED } from '../record/outbox-sanitize.ts'
import { backfillQuestionRecords, enqueueQuestionRecord } from './question-outbox.ts'

const QUESTION_RECORD_PAYLOAD_COLUMNS = OUTBOX_PAYLOAD_CONTRACTS.question.columns
// The hosted edge accepts workflowTaskId; the local producer starts sending it in DEV-1772 slice b.
const UNSENT_QUESTION_COLUMNS = new Set(['workflowTaskId'])

const RUN_RECORD_ID = '01990000-0000-7000-8000-000000000042'

function fixture(): Database {
  const database = migratedTestDatabase()
  fixtureProjectRecordId(database)
  database
    .query(
      `INSERT INTO run
       (number,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
       VALUES (42,?,'2026-09-25T10:00:00.000Z','codex','implement','sha',3,'ask','asking',
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run(RUN_RECORD_ID)
  return database
}

test('question payload contains the hosted shape and replaces a pending mutation', () => {
  const database = fixture()
  const question = database
    .query(
      `INSERT INTO question
       (number,record_id,run_record_id,asked_at,question,options,recommendation,why,asked_via)
       VALUES (1,'${newRecordId()}','${RUN_RECORD_ID}','2026-09-25T10:01:00.000Z','Which?', '["one","two"]','one','safer','live')
       RETURNING record_id,number`,
    )
    .get() as { record_id: string; number: number }
  enqueueQuestionRecord(database, question.record_id)
  database
    .query(
      `UPDATE question SET answer='One',answer_basis='specification line 4',answered_at='2026-09-25T10:02:00.000Z',revision=revision+1,
       answered_by='architect',answerer_kind='agent',answer_channel='cli',
       filed_as='canon-proposal',filed_record_id='11111111-1111-4111-8111-111111111111',
       filed_label='${PLATFORM_SLUG}#44' WHERE record_id=?`,
    )
    .run(question.record_id)
  database
    .query(
      `INSERT INTO question_mutation_audit (record_id,question_record_id,action,actor_session,at,reason)
       VALUES ('${newRecordId()}', ?,'rule','architect','2026-09-25T10:02:00.000Z','One')`,
    )
    .run(question.record_id)
  enqueueQuestionRecord(database, question.record_id)

  const rows = database
    .query<{ payload: string }, []>("SELECT payload FROM outbox WHERE kind='question'")
    .all()
  expect(rows).toHaveLength(1)
  const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>
  expect(Object.keys(payload).sort()).toEqual(
    QUESTION_RECORD_PAYLOAD_COLUMNS.filter((column) => !UNSENT_QUESTION_COLUMNS.has(column)).sort(),
  )
  expect(payload).toMatchObject({
    runId: RUN_RECORD_ID,
    localId: question.number,
    options: ['one', 'two'],
    answer: 'One',
    answerBasis: 'specification line 4',
    revision: 2,
    withheldFields: [],
    answeredAt: '2026-09-25T10:02:00.000Z',
    filedRef: null,
    filedRecordId: '11111111-1111-4111-8111-111111111111',
    filedLabel: `${PLATFORM_SLUG}#44`,
    audits: [
      {
        action: 'rule',
        actorSession: 'architect',
        at: '2026-09-25T10:02:00.000Z',
        reason: 'One',
      },
    ],
  })
})

test.each(['quarantined', 'retired'])(
  'a question mutation does not overwrite a %s row',
  (state) => {
    const database = fixture()
    const question = database
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question)
       VALUES (1,'${newRecordId()}','${RUN_RECORD_ID}','2026-09-25T10:01:00.000Z','Which?') RETURNING record_id`,
      )
      .get() as { record_id: string }
    enqueueQuestionRecord(database, question.record_id)
    const original = database
      .query<{ id: number; payload: string }, []>('SELECT id,payload FROM outbox')
      .get()!
    database
      .query(
        `UPDATE outbox SET ${state === 'quarantined' ? 'quarantined_at' : 'retired_at'}=? WHERE id=?`,
      )
      .run('2026-09-25T10:02:00.000Z', original.id)
    database
      .query("UPDATE question SET answer='Corrected',revision=2 WHERE record_id=?")
      .run(question.record_id)

    enqueueQuestionRecord(database, question.record_id)

    const rows = database
      .query<{ id: number; payload: string }, []>('SELECT id,payload FROM outbox ORDER BY id')
      .all()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(original)
    expect(JSON.parse(rows[1]!.payload)).toMatchObject({ answer: 'Corrected', revision: 2 })
    database.close()
  },
)

test('secret-shaped hosted fields are withheld while local text stays intact', () => {
  const database = fixture()
  const secret = 'Authorization: Bearer top-secret-value'
  const question = database
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question,answer,answer_basis,answered_at,revision)
       VALUES (1,'${newRecordId()}','${RUN_RECORD_ID}','2026-09-25T10:01:00.000Z','Which?',?,?,'2026-09-25T10:02:00.000Z',2)
       RETURNING record_id`,
    )
    .get(secret, secret) as { record_id: string }
  enqueueQuestionRecord(database, question.record_id)

  expect(
    database
      .query('SELECT answer,answer_basis FROM question WHERE record_id=?')
      .get(question.record_id),
  ).toEqual({ answer: secret, answer_basis: secret })
  const outbox = database
    .query<{ payload: string }, []>("SELECT payload FROM outbox WHERE kind='question'")
    .get()!
  const payload = JSON.parse(outbox.payload) as Record<string, unknown>
  expect(payload.answer).toBe(WITHHELD_SECRET_SHAPED)
  expect(payload.answerBasis).toBe(WITHHELD_SECRET_SHAPED)
  expect(payload.withheldFields).toEqual(['answer', 'answer_basis'])
  expect(outbox.payload).not.toContain(secret)
})

test('a question has an identity before its first enqueue', () => {
  const database = migratedTestDatabase()
  fixtureProjectRecordId(database)
  database
    .query(
      `INSERT INTO run
       (number,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
       VALUES (42,'${RUN_RECORD_ID}','2026-09-25T10:00:00.000Z','codex','implement','sha',3,'ask','asking',
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run()
  const question = database
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question)
       VALUES (1,'${newRecordId()}','${RUN_RECORD_ID}','2026-09-25T10:01:00.000Z','Which?') RETURNING record_id`,
    )
    .get() as { record_id: string }

  expect(question.record_id).toEqual(expect.any(String))
  expect(enqueueQuestionRecord(database, question.record_id)).toBe(true)
  expect(database.query('SELECT kind FROM outbox ORDER BY id').all()).toEqual([
    { kind: 'question' },
  ])
})

test('question and outbox writes roll back together', () => {
  const database = fixture()
  expect(() =>
    writeTransaction(() => {
      const question = database
        .query(
          `INSERT INTO question (number,record_id,run_record_id,asked_at,question)
           VALUES (1,'${newRecordId()}','${RUN_RECORD_ID}','2026-09-25T10:01:00.000Z','Which?') RETURNING record_id`,
        )
        .get() as { record_id: string }
      enqueueQuestionRecord(database, question.record_id)
      throw new Error('rollback')
    }, database),
  ).toThrow('rollback')
  expect(database.query('SELECT record_id FROM question').all()).toEqual([])
  expect(database.query("SELECT id FROM outbox WHERE kind='question'").all()).toEqual([])
})

test('question backfill enqueues all existing rows once', () => {
  const database = fixture()
  database
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question)
       VALUES (1,'${newRecordId()}','${RUN_RECORD_ID}','2026-09-25T10:01:00.000Z','One?'),
              (2,'${newRecordId()}','${RUN_RECORD_ID}','2026-09-25T10:02:00.000Z','Two?')`,
    )
    .run()
  expect(backfillQuestionRecords(database)).toEqual({ enqueued: 2 })
  expect(backfillQuestionRecords(database)).toEqual({ enqueued: 0 })
  expect(database.query("SELECT count(*) count FROM outbox WHERE kind='question'").get()).toEqual({
    count: 2,
  })
})
