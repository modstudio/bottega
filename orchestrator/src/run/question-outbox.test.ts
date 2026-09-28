import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { writeTransaction } from '../database/db.ts'
import { applyMigrations } from '../database/migrations.ts'
import { WITHHELD_SECRET_SHAPED } from '../record/outbox-sanitize.ts'
import {
  backfillQuestionRecords,
  enqueueQuestionRecord,
  QUESTION_RECORD_PAYLOAD_COLUMNS,
} from './question-outbox.ts'
import { enqueueRunRecord } from './run-outbox.ts'

const RUN_RECORD_ID = '01990000-0000-7000-8000-000000000042'

function fixture(): Database {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query(
      `INSERT INTO run
       (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (42,?,'2026-09-25T10:00:00.000Z','codex','implement','sha',3,'ask','asking')`,
    )
    .run(RUN_RECORD_ID)
  return database
}

test('question payload contains the hosted shape and replaces a pending mutation', () => {
  const database = fixture()
  const question = database
    .query(
      `INSERT INTO question
       (run_id,asked_at,question,options,recommendation,why,asked_via)
       VALUES (42,'2026-09-25T10:01:00.000Z','Which?', '["one","two"]','one','safer','live')
       RETURNING id`,
    )
    .get() as { id: number }
  enqueueQuestionRecord(database, question.id)
  database
    .query(
      `UPDATE question SET answer='One',answered_at='2026-09-25T10:02:00.000Z',revision=revision+1,
       answered_by='architect',answerer_kind='agent',answer_channel='cli' WHERE id=?`,
    )
    .run(question.id)
  database
    .query(
      `INSERT INTO question_mutation_audit (question_id,action,actor_session,at,reason)
       VALUES (?,'rule','architect','2026-09-25T10:02:00.000Z','One')`,
    )
    .run(question.id)
  enqueueQuestionRecord(database, question.id)

  const rows = database
    .query<{ payload: string }, []>("SELECT payload FROM outbox WHERE kind='question'")
    .all()
  expect(rows).toHaveLength(1)
  const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>
  expect(Object.keys(payload).sort()).toEqual([...QUESTION_RECORD_PAYLOAD_COLUMNS].sort())
  expect(payload).toMatchObject({
    runId: RUN_RECORD_ID,
    localId: question.id,
    options: ['one', 'two'],
    answer: 'One',
    revision: 2,
    withheldFields: [],
    answeredAt: '2026-09-25T10:02:00.000Z',
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
        `INSERT INTO question (run_id,asked_at,question)
       VALUES (42,'2026-09-25T10:01:00.000Z','Which?') RETURNING id`,
      )
      .get() as { id: number }
    enqueueQuestionRecord(database, question.id)
    const original = database
      .query<{ id: number; payload: string }, []>('SELECT id,payload FROM outbox')
      .get()!
    database
      .query(
        `UPDATE outbox SET ${state === 'quarantined' ? 'quarantined_at' : 'retired_at'}=? WHERE id=?`,
      )
      .run('2026-09-25T10:02:00.000Z', original.id)
    database.query("UPDATE question SET answer='Corrected',revision=2 WHERE id=?").run(question.id)

    enqueueQuestionRecord(database, question.id)

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
      `INSERT INTO question (run_id,asked_at,question,answer,answered_at,revision)
       VALUES (42,'2026-09-25T10:01:00.000Z','Which?',?,'2026-09-25T10:02:00.000Z',2)
       RETURNING id`,
    )
    .get(secret) as { id: number }
  enqueueQuestionRecord(database, question.id)

  expect(database.query('SELECT answer FROM question WHERE id=?').get(question.id)).toEqual({
    answer: secret,
  })
  const outbox = database
    .query<{ payload: string }, []>("SELECT payload FROM outbox WHERE kind='question'")
    .get()!
  const payload = JSON.parse(outbox.payload) as Record<string, unknown>
  expect(payload.answer).toBe(WITHHELD_SECRET_SHAPED)
  expect(payload.withheldFields).toEqual(['answer'])
  expect(outbox.payload).not.toContain(secret)
})

test('question enqueue waits for its run enqueue to mint the parent identity', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query(
      `INSERT INTO run
       (id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (42,'2026-09-25T10:00:00.000Z','codex','implement','sha',3,'ask','asking')`,
    )
    .run()
  const question = database
    .query(
      `INSERT INTO question (run_id,asked_at,question)
       VALUES (42,'2026-09-25T10:01:00.000Z','Which?') RETURNING id`,
    )
    .get() as { id: number }

  expect(enqueueQuestionRecord(database, question.id)).toBe(false)
  expect(database.query('SELECT record_id FROM run WHERE id=42').get()).toEqual({ record_id: null })
  expect(database.query("SELECT id FROM outbox WHERE kind='question'").all()).toEqual([])

  enqueueRunRecord(database, 42, '01990000-0000-7000-8000-000000000099', '2026-09-25T10:01:00.000Z')
  expect(enqueueQuestionRecord(database, question.id)).toBe(true)
  expect(database.query('SELECT kind FROM outbox ORDER BY id').all()).toEqual([
    { kind: 'run' },
    { kind: 'question' },
  ])
})

test('question and outbox writes roll back together', () => {
  const database = fixture()
  expect(() =>
    writeTransaction(() => {
      const question = database
        .query(
          `INSERT INTO question (run_id,asked_at,question)
           VALUES (42,'2026-09-25T10:01:00.000Z','Which?') RETURNING id`,
        )
        .get() as { id: number }
      enqueueQuestionRecord(database, question.id)
      throw new Error('rollback')
    }, database),
  ).toThrow('rollback')
  expect(database.query('SELECT id FROM question').all()).toEqual([])
  expect(database.query("SELECT id FROM outbox WHERE kind='question'").all()).toEqual([])
})

test('question backfill mints identities once and enqueues all existing rows', () => {
  const database = fixture()
  database
    .query(
      `INSERT INTO question (run_id,asked_at,question)
       VALUES (42,'2026-09-25T10:01:00.000Z','One?'),
              (42,'2026-09-25T10:02:00.000Z','Two?')`,
    )
    .run()
  expect(backfillQuestionRecords(database)).toEqual({ minted: 2, enqueued: 2 })
  expect(backfillQuestionRecords(database)).toEqual({ minted: 0, enqueued: 0 })
  expect(database.query("SELECT count(*) count FROM outbox WHERE kind='question'").get()).toEqual({
    count: 2,
  })
})
