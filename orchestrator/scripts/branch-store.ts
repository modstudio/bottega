import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FROZEN_STATE_NAMES } from '../../shared/brand.ts'
import { DATABASE_RESOLUTION } from '../src/database/database-location.ts'
import {
  applyMigrations,
  MIGRATIONS_FOLDER,
  migrationJournal,
  splitMigrationSource,
} from '../src/database/migrations.ts'

export type BranchStoreKind = 'current' | 'behind' | 'ahead' | 'absent'
export type JournalFact = { when: number; hash: string }
export type AppliedLedgerFact = { when: number; hash: string }

export function classifyBranchStore(
  journal: JournalFact[],
  applied: AppliedLedgerFact[] | null,
): BranchStoreKind {
  if (applied === null) return 'absent'
  const expected = new Map(journal.map((entry) => [entry.when, entry.hash]))
  if (applied.some((entry) => expected.get(entry.when) !== entry.hash)) return 'ahead'
  if (applied.length > journal.length) return 'ahead'
  const present = new Set(applied.map((entry) => `${entry.when}:${entry.hash}`))
  if (journal.some((entry) => !present.has(`${entry.when}:${entry.hash}`))) return 'behind'
  return 'current'
}

function journalFacts(): JournalFact[] {
  return migrationJournal().map((entry) => ({
    when: entry.when,
    hash: createHash('sha256')
      .update(
        splitMigrationSource(readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), 'utf8')).ddl,
      )
      .digest('hex'),
  }))
}

function tableExists(database: Database, table: string): boolean {
  return !!database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
}

export function classifyStore(path: string | null): BranchStoreKind {
  if (!path || !existsSync(path)) return classifyBranchStore(journalFacts(), null)
  const database = new Database(path, { readonly: true })
  try {
    database.exec('PRAGMA busy_timeout = 15000')
    const applied = tableExists(database, 'orch_migrations')
      ? (
          database
            .query('SELECT hash, created_at FROM orch_migrations ORDER BY created_at')
            .all() as { hash: string; created_at: number }[]
        ).map((entry) => ({
          when: Number(entry.created_at),
          hash: entry.hash,
        }))
      : []
    return classifyBranchStore(journalFacts(), applied)
  } finally {
    database.close()
  }
}

export function liveStorePath(): string | null {
  if (process.env.ORCH_DB) return existsSync(process.env.ORCH_DB) ? process.env.ORCH_DB : null
  for (const path of [DATABASE_RESOLUTION.mainStorePath, DATABASE_RESOLUTION.path]) {
    if (path && existsSync(path)) return path
  }
  return null
}

export function withBranchStoreScratch<T>(name: string, fn: (dir: string) => T): T {
  const base = process.env.ORCH_SCRATCH
    ? join(process.env.ORCH_SCRATCH, name)
    : join(tmpdir(), `orch-${name}`)
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'store-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function snapshotStore(source: string, destDir: string): string {
  const destination = join(destDir, FROZEN_STATE_NAMES.orchestratorDatabase)
  const database = new Database(source, { readonly: true })
  try {
    database.exec('PRAGMA busy_timeout = 15000')
    database.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`)
  } finally {
    database.close()
  }
  return destination
}

export function migrateStore(path: string): void {
  const database = new Database(path)
  try {
    database.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;')
    applyMigrations(database)
  } finally {
    database.close()
  }
}

export function mintFixtureStore(destDir: string): string {
  const path = join(destDir, FROZEN_STATE_NAMES.orchestratorDatabase)
  const database = new Database(path, { create: true })
  try {
    database.exec('PRAGMA foreign_keys = ON;')
    applyMigrations(database)
  } finally {
    database.close()
  }
  return path
}
