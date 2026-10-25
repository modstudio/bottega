import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

function beforeCursorRekey(): Database {
  const folder = mkdtempSync(join(tmpdir(), 'hub-cursor-migration-stage-'))
  mkdirSync(join(folder, 'meta'))
  const entries = migrationJournal().slice(0, 38)
  for (const entry of entries)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
  )
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d, folder, HUB_MIGRATION_BACKFILL_VALUES)
  rmSync(folder, { recursive: true, force: true })
  return d
}

test('hub cursor UUID migration maps question and workflow email references', () => {
  const d = beforeCursorRekey()
  const cursor = '01990000-0000-7000-8000-000000000576'
  try {
    d.exec(`
      INSERT INTO question(record_id,number,workflow_cursor_id,asked_at) VALUES
        ('01990000-0000-7000-8000-000000000001',1,576,'2026-10-23');
      INSERT INTO operator_waiting_email(kind,item_id,episode,pushed_at) VALUES
        ('workflow',576,'episode','2026-10-23');
    `)
    expect(
      applyMigrations(
        d,
        undefined,
        HUB_MIGRATION_BACKFILL_VALUES,
        [],
        [{ number: 576, record_id: cursor }],
      ),
    ).toContain('0038_workflow_cursor_uuid_key')
    expect(d.query('SELECT workflow_cursor_id FROM question').get()).toEqual({
      workflow_cursor_id: cursor,
    })
    expect(d.query('SELECT item_id FROM operator_waiting_email').get()).toEqual({ item_id: cursor })
  } finally {
    d.close()
  }
})

test('hub cursor UUID migration refuses a missing identity atomically', () => {
  const d = beforeCursorRekey()
  try {
    d.exec(`INSERT INTO question(record_id,number,workflow_cursor_id,asked_at) VALUES
      ('01990000-0000-7000-8000-000000000001',1,576,'2026-10-23')`)
    expect(() => applyMigrations(d, undefined, HUB_MIGRATION_BACKFILL_VALUES)).toThrow(
      `cursor numbers [576]; restore the matching orchestrator store and rerun ${PLATFORM_SLUG} machine migrate`,
    )
    expect(
      d
        .query("SELECT type FROM pragma_table_info('question') WHERE name='workflow_cursor_id'")
        .get(),
    ).toEqual({ type: 'INTEGER' })
  } finally {
    d.close()
  }
})
