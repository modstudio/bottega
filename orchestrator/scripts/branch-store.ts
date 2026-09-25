import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FROZEN_STATE_NAMES } from '../../shared/brand.ts'
import { DATABASE_RESOLUTION } from '../src/database/database-location.ts'
import {
  applyMigrations,
  MIGRATIONS_FOLDER,
  storeMigrationState,
} from '../src/database/migrations.ts'

export type BranchStoreKind = 'current' | 'behind' | 'ahead' | 'absent'

export function classifyStore(path: string | null, folder = MIGRATIONS_FOLDER): BranchStoreKind {
  if (!path || !existsSync(path)) return 'absent'
  const database = new Database(path, { readonly: true })
  try {
    database.exec('PRAGMA busy_timeout = 15000')
    return storeMigrationState(database, folder)
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
