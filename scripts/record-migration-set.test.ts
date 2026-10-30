import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordMigrationSetHash, recordMigrationSetHashFrom } from './record-migration-set.ts'
import { recordRehearsalDescription } from './record-rehearsal-status.ts'

const migration = (name: string, sql: string) => ({ name, sql: Buffer.from(sql) })

test('hash changes when migration SQL changes', () => {
  const original = recordMigrationSetHash([migration('20260101_first', 'SELECT 1;')])
  const changed = recordMigrationSetHash([migration('20260101_first', 'SELECT 2;')])
  expect(changed).not.toBe(original)
})

test('rehearsal status descriptions round trip through their shared contract', () => {
  const description = {
    hash: 'a'.repeat(64),
    pending: 1,
    restoreMs: 123,
    migrateMs: 45,
    dump: 'record/new.dump',
  }
  expect(recordRehearsalDescription.parse(recordRehearsalDescription.format(description))).toEqual(
    description,
  )
})

test('hash changes when a migration folder is added', () => {
  const original = recordMigrationSetHash([migration('20260101_first', 'SELECT 1;')])
  const changed = recordMigrationSetHash([
    migration('20260101_first', 'SELECT 1;'),
    migration('20260102_second', 'SELECT 2;'),
  ])
  expect(changed).not.toBe(original)
})

test('hash does not change when a file outside the migrations folder changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'record-migration-set-'))
  try {
    const folder = join(root, 'shared', 'record', 'migrations')
    mkdirSync(join(folder, '20260101_first'), { recursive: true })
    writeFileSync(join(folder, '20260101_first', 'migration.sql'), 'SELECT 1;')
    const original = recordMigrationSetHashFrom(folder)
    writeFileSync(join(root, 'README.md'), 'changed outside shared/record/migrations')
    expect(recordMigrationSetHashFrom(folder)).toBe(original)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
