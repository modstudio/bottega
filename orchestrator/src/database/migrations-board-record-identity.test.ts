import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import {
  applyMigrations,
  canonicalSchemaHash,
  expectedSchemaHash,
  MIGRATIONS_FOLDER,
  migrationJournal,
} from './migrations.ts'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HOSTED_ID = '01990000-0000-7000-8000-0000000021e1'
const TABLES = [
  'board_claim',
  'board_hosted_adoption_ledger',
  'board_hosted_adoption_receipt',
  'board_message',
  'board_message_tag',
  'board_reach_delivery',
  'board_reach_recording_failure',
  'board_receipt',
] as const

test('board identity migration fills ids, copies adopted hosted ids, and preserves rows', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-board-record-identity-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const migration = journal.findIndex((entry) => entry.tag === '0111_board_record_identity')
  const prior = journal.slice(0, migration)
  for (const entry of prior)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = new Database(':memory:')
  try {
    database.exec('PRAGMA foreign_keys=ON')
    applyMigrations(database, folder)
    database.exec(`
      INSERT INTO board_message
        (id,kind,author_kind,audience,title,body,ack_required,expires_at,created_at,purpose)
        VALUES (1,'notice','operator','operator','Adopted','Body',0,'2026-10-14','2026-10-13','information');
      INSERT INTO board_message
        (id,kind,author_kind,audience,title,body,ack_required,expires_at,created_at,purpose)
        VALUES (2,'notice','operator','operator','Local','Body',0,'2026-10-14','2026-10-13','information');
      INSERT INTO board_message_tag (message_id,kind,value,origin)
        VALUES (1,'topic','gate','sender');
      INSERT INTO board_receipt
        (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
        VALUES (1,'operator',1,'2026-10-13',NULL);
      INSERT INTO board_claim
        (id,project,subject_kind,subject_value,holder_kind,duration_ms,taken_at,renewed_at,lapses_at)
        VALUES (3,'${PLATFORM_NAME}','task','DEV-1214','operator',1000,'2026-10-13','2026-10-13','2026-10-14');
      INSERT INTO board_hosted_adoption_ledger
        (local_kind,local_id,hosted_id,state,refusal,created_at,updated_at)
        VALUES ('notice',1,'${HOSTED_ID}','uploaded',NULL,'2026-10-13','2026-10-13');
      INSERT INTO board_hosted_adoption_receipt
        (local_message_id,reader_session,state,refusal,updated_at)
        VALUES (1,'operator','uploaded',NULL,'2026-10-13');
      INSERT INTO board_reach_delivery
        (message_source,message_id,reader_session,reader_project,delivery_point,blocked_stop,
         audience,acknowledgement_required,posted_at,session_started_at,posting_timing,concern,
         recorded_at)
        VALUES ('local','1','operator','${PLATFORM_NAME}','stop',0,'operator',0,'2026-10-13','2026-10-13',
                'after-session','concerned','2026-10-13');
      INSERT INTO board_reach_recording_failure (recorded_at) VALUES ('2026-10-13');
    `)
    const before = Object.fromEntries(
      TABLES.map((table) => [
        table,
        database.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()!
          .count,
      ]),
    )
    expect(applyMigrations(database)).toEqual(['0111_board_record_identity'])
    for (const table of TABLES) {
      expect(database.query(`SELECT count(*) AS count FROM ${table}`).get(), table).toEqual({
        count: before[table],
      })
      const ids = database.query<{ record_id: string }, []>(`SELECT record_id FROM ${table}`).all()
      expect(ids).toHaveLength(before[table]!)
      expect(new Set(ids.map((row) => row.record_id)).size).toBe(ids.length)
      expect(
        database
          .query<{ unique: number }, []>(
            `SELECT "unique" FROM pragma_index_list('${table}') WHERE name='${table}_record_id_unique'`,
          )
          .get()?.unique,
      ).toBe(1)
      expect(
        database
          .query<{ notnull: number; dflt_value: string | null }, []>(
            `SELECT "notnull",dflt_value FROM pragma_table_info('${table}') WHERE name='record_id'`,
          )
          .get(),
      ).toEqual({ notnull: 1, dflt_value: null })
    }
    expect(
      database
        .query<{ record_id: string }, []>('SELECT record_id FROM board_message WHERE id=1')
        .get()?.record_id,
    ).toBe(HOSTED_ID)
    expect(
      database
        .query<{ record_id: string }, []>('SELECT record_id FROM board_message WHERE id=2')
        .get()?.record_id,
    ).toMatch(UUID_V4)
    expect(
      database
        .query<{ record_id: string }, []>('SELECT record_id FROM board_claim WHERE id=3')
        .get()?.record_id,
    ).toMatch(UUID_V4)
    expect(() =>
      database.exec(`INSERT INTO board_message
        (kind,author_kind,audience,title,body,ack_required,expires_at,created_at,purpose,record_id)
        SELECT 'notice','operator','operator','Dup','Body',0,'2026-10-14','2026-10-13','information',
               record_id FROM board_message WHERE id=1`),
    ).toThrow('UNIQUE constraint failed: board_message.record_id')
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
    const fresh = new Database(':memory:')
    fresh.exec('PRAGMA foreign_keys=ON')
    applyMigrations(fresh)
    const schemaRows = (subject: Database) =>
      subject
        .query(
          `SELECT type,name,tbl_name,sql FROM sqlite_master
           WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`,
        )
        .all()
    expect(schemaRows(database)).toEqual(schemaRows(fresh))
    expect(canonicalSchemaHash(database)).toBe(canonicalSchemaHash(fresh))
    fresh.close()
    expect(canonicalSchemaHash(database)).toBe(expectedSchemaHash())
  } finally {
    database.close()
    rmSync(folder, { recursive: true, force: true })
  }
})
