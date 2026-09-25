import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from '../src/database/migrations.ts'
import { classifyBranchStore, classifyStore, migrateStore, snapshotStore } from './branch-store.ts'

test('classifies branch journal and applied-ledger facts', () => {
  const journal = [
    { when: 1, hash: 'one' },
    { when: 2, hash: 'two' },
  ]
  expect(classifyBranchStore(journal, null)).toBe('absent')
  expect(classifyBranchStore(journal, journal)).toBe('current')
  expect(classifyBranchStore(journal, journal.slice(0, 1))).toBe('behind')
  expect(classifyBranchStore(journal.slice(0, 1), journal)).toBe('ahead')
  expect(classifyBranchStore(journal.slice(0, 1), [journal[0]!, journal[0]!])).toBe('ahead')
  expect(classifyBranchStore(journal, [journal[0]!, { when: 2, hash: 'changed' }])).toBe('ahead')
})

test('snapshots a prior store, migrates the snapshot, and leaves the source unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-branch-store-'))
  const migrations = join(dir, 'migrations')
  const source = join(dir, 'source.db')
  const snapshots = join(dir, 'snapshots')
  mkdirSync(join(migrations, 'meta'), { recursive: true })
  mkdirSync(snapshots)
  const prior = migrationJournal().slice(0, -1)
  for (const entry of prior) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(migrations, `${entry.tag}.sql`))
  }
  writeFileSync(
    join(migrations, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )

  const database = new Database(source, { create: true })
  try {
    applyMigrations(database, migrations)
  } finally {
    database.close()
  }

  try {
    expect(classifyStore(source)).toBe('behind')
    const snapshot = snapshotStore(source, snapshots)
    migrateStore(snapshot)
    expect(classifyStore(snapshot)).toBe('current')
    expect(classifyStore(source)).toBe('behind')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
