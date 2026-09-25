import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from '../src/database/migrations.ts'
import { classifyStore, migrateStore, snapshotStore } from './branch-store.ts'

function writeMigrationFolder(folder: string, entries = migrationJournal().slice(0, -1)): void {
  mkdirSync(join(folder, 'meta'), { recursive: true })
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  }
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
  )
}

test('classifies stores against full and truncated migration journals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-branch-store-classify-'))
  const migrations = join(dir, 'migrations')
  const prior = join(dir, 'prior.db')
  const current = join(dir, 'current.db')
  writeMigrationFolder(migrations)

  for (const [path, folder] of [
    [prior, migrations],
    [current, MIGRATIONS_FOLDER],
  ] as const) {
    const database = new Database(path, { create: true })
    try {
      applyMigrations(database, folder)
    } finally {
      database.close()
    }
  }

  try {
    expect(classifyStore(null)).toBe('absent')
    expect(classifyStore(current)).toBe('current')
    expect(classifyStore(prior)).toBe('behind')
    expect(classifyStore(current, migrations)).toBe('ahead')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('snapshots a prior store, migrates the snapshot, and leaves the source unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-branch-store-'))
  const migrations = join(dir, 'migrations')
  const source = join(dir, 'source.db')
  const snapshots = join(dir, 'snapshots')
  mkdirSync(snapshots)
  writeMigrationFolder(migrations)

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
