import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { fixtureProjectRecordId, migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0228_question_reference_without_fk'
const TABLES = ['question_delivery', 'run_carried_ruling', 'operator_notification'] as const
const INDEXES = [
  'sqlite_autoindex_question_delivery_1',
  'question_delivery_run_record_id_idx',
  'question_delivery_question',
  'sqlite_autoindex_run_carried_ruling_1',
  'sqlite_autoindex_run_carried_ruling_2',
  'run_carried_ruling_question_record_id_idx',
  'sqlite_autoindex_operator_notification_1',
  'operator_notification_question_record_id_idx',
  'operator_notification_question_episode',
  'operator_notification_workflow_episode',
] as const

function rows(database: Database, table: (typeof TABLES)[number]): unknown[] {
  return database.query(`SELECT * FROM ${table} ORDER BY record_id`).all()
}

test('question reference migration preserves rows and constraints without local question parents', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  const runRecordId = newRecordId()
  const questionRecordId = newRecordId()
  const deliveryRecordId = newRecordId()
  const carriedRecordId = newRecordId()
  const notificationRecordId = newRecordId()
  try {
    const projectRecordId = fixtureProjectRecordId(database)
    database
      .query(
        `INSERT INTO run(record_id,number,project_record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
         VALUES (?,1,?,'2026-11-15','codex','implement','sha',1,'prompt','asking')`,
      )
      .run(runRecordId, projectRecordId)
    database
      .query(
        `INSERT INTO question(record_id,number,run_record_id,asked_at,question,asked_via)
         VALUES (?,1,?,'2026-11-15','Which shape?','reply')`,
      )
      .run(questionRecordId, runRecordId)
    database
      .query(
        `INSERT INTO question_delivery
           (id,question_record_id,run_record_id,mode,outcome,at,error,record_id)
         VALUES (7,?,?,'resume','failed','2026-11-15','offline',?)`,
      )
      .run(questionRecordId, runRecordId, deliveryRecordId)
    database
      .query(
        `INSERT INTO run_carried_ruling(record_id,run_record_id,question_record_id)
         VALUES (?,?,?)`,
      )
      .run(carriedRecordId, runRecordId, questionRecordId)
    database
      .query(
        `INSERT INTO operator_notification
           (record_id,kind,question_record_id,episode,notified_at)
         VALUES (?,'question',?,'episode','2026-11-15')`,
      )
      .run(notificationRecordId, questionRecordId)

    const before = new Map(TABLES.map((table) => [table, rows(database, table)]))
    expect(applyMigrations(database)).toContain(MIGRATION)

    for (const table of TABLES) {
      expect(rows(database, table), table).toEqual(before.get(table)!)
      expect(
        database
          .query<{ table: string }, []>(`PRAGMA foreign_key_list('${table}')`)
          .all()
          .map((foreignKey) => foreignKey.table),
        table,
      ).not.toContain('question')
    }
    const indexNames = new Set(
      database
        .query<{ name: string }, [string, string, string]>(
          `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN (${TABLES.map(() => '?').join(',')})`,
        )
        .all(...TABLES)
        .map((index) => index.name),
    )
    for (const index of INDEXES) expect(indexNames.has(index), index).toBe(true)

    const unknownQuestion = newRecordId()
    expect(() =>
      database
        .query(
          `INSERT INTO question_delivery
             (record_id,question_record_id,mode,outcome,at)
           VALUES (?,?,'record-only','retired','2026-11-15')`,
        )
        .run(newRecordId(), unknownQuestion),
    ).not.toThrow()
    expect(() =>
      database
        .query(
          `INSERT INTO run_carried_ruling(record_id,run_record_id,question_record_id)
           VALUES (?,?,?)`,
        )
        .run(newRecordId(), newRecordId(), unknownQuestion),
    ).toThrow('FOREIGN KEY constraint failed')
  } finally {
    database.close()
  }
})
