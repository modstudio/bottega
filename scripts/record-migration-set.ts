#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SQL } from 'bun'
import { pendingRecordMigrationNames } from '../orchestrator/src/postgres/postgres-migrate.ts'

export type RecordMigration = { name: string; sql: Uint8Array }

export function recordMigrationSetHash(migrations: readonly RecordMigration[]): string {
  const hash = createHash('sha256')
  for (const migration of migrations.toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    hash.update(migration.name)
    hash.update(migration.sql)
  }
  return hash.digest('hex')
}

function readRecordMigrations(folder: string): RecordMigration[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return []
    const path = join(folder, entry.name, 'migration.sql')
    try {
      return [{ name: entry.name, sql: readFileSync(path) }]
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'ENOENT') return []
      throw error
    }
  })
}

export function recordMigrationSetHashFrom(folder: string): string {
  return recordMigrationSetHash(readRecordMigrations(folder))
}

if (import.meta.main) {
  if (process.argv.includes('--pending')) {
    const url = process.env.BOTTEGA_RECORD_MIGRATE_URL
    if (!url) throw new Error('BOTTEGA_RECORD_MIGRATE_URL is required to read pending migrations')
    const sql = new SQL(url)
    try {
      process.stdout.write((await pendingRecordMigrationNames(sql)).join('\n'))
    } finally {
      await sql.close()
    }
  } else {
    const root = fileURLToPath(new URL('..', import.meta.url))
    console.log(recordMigrationSetHashFrom(join(root, 'shared', 'record', 'migrations')))
  }
}
