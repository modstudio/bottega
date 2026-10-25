import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import { applyMigrations } from './migrations.ts'

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`

function missingForeignKeyTargets(d: Database): string[] {
  const tables = d
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
  const tableNames = new Set(tables.map((row) => row.name))
  return tables.flatMap(({ name }) =>
    d
      .query<{ from: string; table: string }, []>(
        `PRAGMA foreign_key_list(${quoteIdentifier(name)})`,
      )
      .all()
      .filter((foreignKey) => !tableNames.has(foreignKey.table))
      .map((foreignKey) => `${name}.${foreignKey.from} -> ${foreignKey.table}`),
  )
}

test('a replay from the stale-target connection state has only resolvable foreign-key targets', () => {
  const d = new Database(':memory:')
  // The state that leaves stale rename targets; platform defaults differ, so set it explicitly.
  d.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON')
  applyMigrations(d, undefined, HUB_MIGRATION_BACKFILL_VALUES)
  expect(missingForeignKeyTargets(d)).toEqual([])
  expect(d.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  expect(d.query('PRAGMA legacy_alter_table').get()).toEqual({ legacy_alter_table: 1 })
  d.close()
})

test('a migration that creates a dangling reference is refused and rolled back', () => {
  const folder = mkdtempSync(join(tmpdir(), 'hub-dangling-migration-'))
  mkdirSync(join(folder, 'meta'))
  const entries = [
    { idx: 0, version: '6', when: 1, tag: '0000_parent', breakpoints: true },
    { idx: 1, version: '6', when: 2, tag: '0001_orphan', breakpoints: true },
  ]
  writeFileSync(join(folder, '0000_parent.sql'), 'CREATE TABLE parent (id INTEGER PRIMARY KEY);')
  const writeJournal = (count: number) =>
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'sqlite', entries: entries.slice(0, count) }),
    )
  writeJournal(1)
  const d = new Database(':memory:')
  applyMigrations(d, folder)
  writeFileSync(
    join(folder, '0001_orphan.sql'),
    'CREATE TABLE orphan (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id)); INSERT INTO orphan VALUES (1, 42);',
  )
  writeJournal(2)

  expect(() => applyMigrations(d, folder)).toThrow(
    `refusing to commit migration with dangling foreign keys: 1 violation(s) [table orphan, rowid 1, parent parent, fkid 0]\n` +
      `cleared by: repair the named rows, then run \`${PLATFORM_SLUG} machine migrate\``,
  )
  expect(d.query("SELECT name FROM sqlite_master WHERE name='orphan'").get()).toBeNull()
  d.close()
  rmSync(folder, { recursive: true, force: true })
})

test('migration refuses when its connection policy cannot be established', () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys = ON; PRAGMA legacy_alter_table = ON; BEGIN IMMEDIATE')
  expect(() => applyMigrations(d)).toThrow(
    `cleared by: run \`${PLATFORM_SLUG} machine migrate\`, which opens its own connection`,
  )
  expect(d.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  expect(d.query('PRAGMA legacy_alter_table').get()).toEqual({ legacy_alter_table: 1 })
  d.exec('ROLLBACK')
  d.close()
})
