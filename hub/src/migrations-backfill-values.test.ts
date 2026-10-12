import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from './migrations.ts'

test('a named backfill value must be supplied by the migration caller', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-backfill-value-'))
  mkdirSync(join(dir, 'meta'))
  writeFileSync(join(dir, '0000_base.sql'), 'CREATE TABLE item (value TEXT);\n')
  writeFileSync(
    join(dir, '0001_fill.sql'),
    '-- BACKFILL\nINSERT INTO item(value) VALUES ($identity);\n-- /BACKFILL\n',
  )
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: [
        { idx: 0, version: '6', when: 1, tag: '0000_base', breakpoints: true },
        { idx: 1, version: '6', when: 2, tag: '0001_fill', breakpoints: true },
      ],
    }),
  )
  const database = new Database(':memory:')
  expect(() => applyMigrations(database, dir)).toThrow('missing migration backfill value: identity')
  expect(applyMigrations(database, dir, { identity: 'machine' })).toEqual([
    '0000_base',
    '0001_fill',
  ])
  expect(database.query('SELECT value FROM item').get()).toEqual({ value: 'machine' })
  database.close()
  rmSync(dir, { recursive: true, force: true })
})
