import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { nextQuestionNumber } from '../run/question-number.ts'
import { applyMigrations, applyMigrationsBefore } from './migrations.ts'

function count(database: Database, table: string): number {
  return database.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()!.n
}

test('question UUID-key migration preserves every local relationship and seeds the shared counter', () => {
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  try {
    applyMigrationsBefore(database, '0125_question_uuid_key')
    const runRecordId = newRecordId()
    database
      .query(
        `INSERT INTO run(record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
         VALUES (?,1,'2026-10-19','codex','implement','sha',1,'prompt','asking')`,
      )
      .run(runRecordId)
    const questionRecordId = newRecordId()
    database
      .query(
        `INSERT INTO question(id,record_id,run_record_id,asked_at,question,asked_via)
         VALUES (41,?,?, '2026-10-19','Which shape?','reply')`,
      )
      .run(questionRecordId, runRecordId)
    database
      .query(
        `INSERT INTO question_delivery(id,record_id,question_id,run_record_id,mode,outcome,at)
         VALUES (7,?,41,?,'resume','delivered','2026-10-19')`,
      )
      .run(newRecordId(), runRecordId)
    database
      .query(
        `INSERT INTO question_mutation_audit(record_id,question_id,action,at)
         VALUES (?,41,'rule','2026-10-19')`,
      )
      .run(newRecordId())
    database
      .query(`INSERT INTO run_carried_ruling(record_id,run_record_id,question_id) VALUES (?,?,41)`)
      .run(newRecordId(), runRecordId)
    database
      .query(
        `INSERT INTO operator_notification(record_id,kind,item_id,episode,notified_at)
         VALUES (?,'question',41,'episode','2026-10-19')`,
      )
      .run(newRecordId())
    database.query("UPDATE sqlite_sequence SET seq=80 WHERE name='question'").run()

    const before = new Map(
      [
        'question',
        'question_delivery',
        'question_mutation_audit',
        'run_carried_ruling',
        'operator_notification',
      ].map((table) => [table, count(database, table)]),
    )
    expect(applyMigrations(database)).toEqual(['0125_question_uuid_key'])
    for (const [table, rows] of before) expect(count(database, table), table).toBe(rows)
    expect(database.query('SELECT record_id,number FROM question').get()).toEqual({
      record_id: questionRecordId,
      number: 41,
    })
    for (const table of ['question_delivery', 'question_mutation_audit', 'run_carried_ruling']) {
      expect(database.query(`SELECT question_record_id FROM ${table}`).get(), table).toEqual({
        question_record_id: questionRecordId,
      })
    }
    expect(database.query('SELECT question_record_id FROM operator_notification').get()).toEqual({
      question_record_id: questionRecordId,
    })
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(
      database
        .query('SELECT last_number FROM entity_number_counter WHERE entity=?')
        .get('question'),
    ).toEqual({ last_number: 80 })
    expect(nextQuestionNumber(database)).toBe(81)
    database.query('DELETE FROM question WHERE record_id=?').run(questionRecordId)
    expect(nextQuestionNumber(database)).toBe(82)
    expect(() =>
      database
        .query(
          `INSERT INTO question_delivery(record_id,question_record_id,mode,outcome,at)
           VALUES (?,?, 'resume','delivered','2026-10-19')`,
        )
        .run(newRecordId(), questionRecordId),
    ).toThrow('FOREIGN KEY constraint failed')
  } finally {
    database.close()
  }
})

for (const orphan of [
  {
    table: 'question_delivery',
    insert: `INSERT INTO question_delivery(record_id,question_id,mode,outcome,at)
      VALUES ('01990000-0000-7000-8000-000000000001',999,'resume','delivered','2026-10-19')`,
  },
  {
    table: 'question_mutation_audit',
    insert: `INSERT INTO question_mutation_audit(record_id,question_id,action,at)
      VALUES ('01990000-0000-7000-8000-000000000002',999,'rule','2026-10-19')`,
  },
  {
    table: 'run_carried_ruling',
    insert: `INSERT INTO run_carried_ruling(record_id,run_record_id,question_id)
      VALUES ('01990000-0000-7000-8000-000000000003','01990000-0000-7000-8000-000000000004',999)`,
  },
] as const) {
  test(`question UUID-key migration refuses an orphan in ${orphan.table} without changing the store`, () => {
    const database = new Database(':memory:')
    try {
      applyMigrationsBefore(database, '0125_question_uuid_key')
      database.exec('PRAGMA foreign_keys=OFF')
      database.exec(orphan.insert)

      expect(() => applyMigrations(database)).toThrow(`${orphan.table}.question_id=1`)
      expect(
        database.query("SELECT name FROM pragma_table_info('question') ORDER BY cid").all(),
      ).toContainEqual({ name: 'id' })
      expect(count(database, orphan.table)).toBe(1)
    } finally {
      database.close()
    }
  })
}
