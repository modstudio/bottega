import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TABLES = ['outbox', 'outbox_quarantine_audit', 'outbox_redaction_audit'] as const

test('outbox identity migration renames subject ids, fills row ids, and preserves audit guards', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-outbox-record-identity-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const migration = journal.findIndex((entry) => entry.tag === '0110_outbox_record_identity')
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
      INSERT INTO outbox (id,kind,record_id,payload,created_at,synced_at)
        VALUES (4,'run','01990000-0000-7000-8000-000000001101','{}','2026-10-14','2026-10-14');
      INSERT INTO outbox_quarantine_audit
        (id,outbox_id,kind,record_id,attempts,disposition,at)
        VALUES (5,4,'run','01990000-0000-7000-8000-000000001101',1,'retry','2026-10-14');
      INSERT INTO outbox_redaction_audit
        (id,outbox_id,kind,record_id,rules,withheld_paths,at)
        VALUES (6,4,'run','01990000-0000-7000-8000-000000001101','[]','[]','2026-10-14');
    `)
    const before = Object.fromEntries(
      TABLES.map((table) => [
        table,
        database.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()!
          .count,
      ]),
    )
    expect(applyMigrations(database)).toContain('0110_outbox_record_identity')
    for (const table of TABLES) {
      expect(database.query(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({
        count: before[table],
      })
      const identity = database
        .query<{ record_id: string; row_id: string }, []>(
          `SELECT record_id,row_id FROM ${table} LIMIT 1`,
        )
        .get()!
      expect(identity.record_id).toMatch(UUID_V4)
      expect(identity.record_id).not.toBe(identity.row_id)
      expect(identity.row_id).toBe('01990000-0000-7000-8000-000000001101')
      expect(
        database
          .query<{ notnull: number; dflt_value: string | null }, []>(
            `SELECT "notnull",dflt_value FROM pragma_table_info('${table}') WHERE name='record_id'`,
          )
          .get(),
      ).toEqual({ notnull: 1, dflt_value: null })
    }
    expect(() =>
      database.exec(`INSERT INTO outbox (id,kind,row_id,payload,created_at,record_id)
        SELECT 14,kind,'01990000-0000-7000-8000-000000001114',payload,created_at,record_id
          FROM outbox WHERE id=4`),
    ).toThrow('UNIQUE constraint failed: outbox.record_id')
    expect(() =>
      database.exec(`INSERT INTO outbox_quarantine_audit
        (id,outbox_id,kind,row_id,attempts,disposition,at,record_id)
        SELECT 15,outbox_id,kind,'01990000-0000-7000-8000-000000001115',attempts,
               disposition,at,record_id
          FROM outbox_quarantine_audit WHERE id=5`),
    ).toThrow('UNIQUE constraint failed: outbox_quarantine_audit.record_id')
    expect(() =>
      database.exec(`INSERT INTO outbox_redaction_audit
        (id,outbox_id,kind,row_id,rules,withheld_paths,at,record_id)
        SELECT 16,outbox_id,kind,'01990000-0000-7000-8000-000000001116',rules,
               withheld_paths,at,record_id
          FROM outbox_redaction_audit WHERE id=6`),
    ).toThrow('UNIQUE constraint failed: outbox_redaction_audit.record_id')
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(() =>
      database.query("UPDATE outbox_quarantine_audit SET reason='changed'").run(),
    ).toThrow('outbox quarantine audit is append-only')
    expect(() => database.query('DELETE FROM outbox_quarantine_audit').run()).toThrow(
      'outbox quarantine audit is append-only',
    )
    expect(() => database.query("UPDATE outbox_redaction_audit SET rules='[]'").run()).toThrow(
      'outbox redaction audit is append-only',
    )
    expect(() => database.query('DELETE FROM outbox_redaction_audit').run()).toThrow(
      'outbox redaction audit is append-only',
    )
  } finally {
    database.close()
    rmSync(folder, { recursive: true, force: true })
  }
})
