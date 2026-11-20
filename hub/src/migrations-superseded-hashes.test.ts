import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitMigrationSource } from '../../shared/migration-source.ts'
import supersededMigrationHashes from '../migrations/meta/_superseded_hashes.json' with {
  type: 'json',
}
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import {
  applyMigrations,
  MIGRATIONS_FOLDER,
  MIGRATIONS_TABLE,
  migrationJournal,
  migrationRefusal,
  recordedMigrationHashState,
} from './migrations.ts'

test('judges current, declared predecessor, and undeclared recorded hashes', () => {
  expect(
    recordedMigrationHashState({
      recordedHash: 'current',
      currentHash: 'current',
      predecessorHashes: ['previous'],
    }),
  ).toBe('applied')
  expect(
    recordedMigrationHashState({
      recordedHash: 'previous',
      currentHash: 'current',
      predecessorHashes: ['previous'],
    }),
  ).toBe('superseded predecessor')
  expect(
    recordedMigrationHashState({
      recordedHash: 'unknown',
      currentHash: 'current',
      predecessorHashes: ['previous'],
    }),
  ).toBe('ahead')
})

test('migrate repairs a declared predecessor hash without rerunning its migration', () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys = ON')
  applyMigrations(d, undefined, HUB_MIGRATION_BACKFILL_VALUES)
  const declared = supersededMigrationHashes.entries.find(
    (candidate) => candidate.tag === '0047_drop_git_tasks',
  )!
  const entry = migrationJournal().find((candidate) => candidate.tag === declared.tag)!
  d.query(`UPDATE ${MIGRATIONS_TABLE} SET hash=? WHERE created_at=?`).run(
    declared.predecessorHash,
    entry.when,
  )

  expect(migrationRefusal(d)).toBeNull()
  expect(applyMigrations(d, undefined, HUB_MIGRATION_BACKFILL_VALUES)).toEqual([])
  const current = createHash('sha256')
    .update(
      splitMigrationSource(readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), 'utf8')).ddl,
    )
    .digest('hex')
  expect(
    d
      .query<{ hash: string }, [number]>(`SELECT hash FROM ${MIGRATIONS_TABLE} WHERE created_at=?`)
      .get(entry.when)?.hash,
  ).toBe(current)
  d.close()
})
