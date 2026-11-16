import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { fixtureProjectRecordId, migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0228_question_reference_without_fk'
const TABLES = ['question_delivery', 'run_carried_ruling', 'operator_notification'] as const

type Table = (typeof TABLES)[number]
type ForeignKey = { id: number; table: string } & Record<string, unknown>

function normalizedSql(sql: string): string {
  return sql
    .replace(
      /\breferences\s+question\s*\(\s*record_id\s*\)(?:\s+on\s+(?:update|delete)\s+cascade)*/gi,
      '',
    )
    .replace(/[\"`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim()
    .toLowerCase()
}

function normalizedTableSql(database: Database, table: Table): string {
  const { sql } = database
    .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table)!
  return normalizedSql(sql)
}

function tableSchema(database: Database, table: Table) {
  const indexes = database
    .query<{ name: string; unique: number; partial: number }, []>(
      `SELECT name,"unique",partial FROM pragma_index_list('${table}')`,
    )
    .all()
    .map((index) => {
      const sql = database
        .query<{ sql: string | null }, [string]>(
          "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
        )
        .get(index.name)!.sql
      return {
        ...index,
        columns: database.query(`PRAGMA index_info('${index.name}')`).all(),
        sql: sql === null ? null : normalizedSql(sql),
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
  return {
    columns: database.query(`PRAGMA table_info('${table}')`).all(),
    indexes,
    foreignKeys: database
      .query<ForeignKey, []>(`PRAGMA foreign_key_list('${table}')`)
      .all()
      .map(({ id: _id, ...foreignKey }) => foreignKey),
    sql: normalizedTableSql(database, table),
  }
}

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
    for (let index = 0; index < 2; index += 1) {
      database
        .query(
          `INSERT INTO question_delivery
             (question_record_id,run_record_id,mode,outcome,at,record_id)
           VALUES (?,?,'resume','delivered','2026-11-15',?)`,
        )
        .run(questionRecordId, runRecordId, newRecordId())
    }
    const deliveryHighWater = database
      .query<{ id: number }, []>('SELECT MAX(id) id FROM question_delivery')
      .get()!.id
    database.query('DELETE FROM question_delivery WHERE id > 7').run()
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

    const beforeRows = new Map(TABLES.map((table) => [table, rows(database, table)]))
    const beforeSchema = new Map(TABLES.map((table) => [table, tableSchema(database, table)]))
    expect(applyMigrations(database)).toContain(MIGRATION)

    for (const table of TABLES) {
      expect(rows(database, table), table).toEqual(beforeRows.get(table)!)
      const expectedSchema = beforeSchema.get(table)!
      expect(tableSchema(database, table), table).toEqual({
        ...expectedSchema,
        foreignKeys: expectedSchema.foreignKeys.filter(
          (foreignKey) => foreignKey.table !== 'question',
        ),
      })
    }

    const unknownQuestion = newRecordId()
    const orphanDelivery = database
      .query(
        `INSERT INTO question_delivery
           (record_id,question_record_id,mode,outcome,at)
         VALUES (?,?,'record-only','retired','2026-11-15')`,
      )
      .run(newRecordId(), unknownQuestion)
    expect(Number(orphanDelivery.lastInsertRowid)).toBeGreaterThan(deliveryHighWater)
    expect(() =>
      database
        .query(
          `INSERT INTO run_carried_ruling(record_id,run_record_id,question_record_id)
           VALUES (?,?,?)`,
        )
        .run(newRecordId(), runRecordId, unknownQuestion),
    ).not.toThrow()
  } finally {
    database.close()
  }
})
