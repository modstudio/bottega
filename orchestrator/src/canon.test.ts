import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTableName } from 'drizzle-orm'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import * as declared from './schema.ts'
import {
  applyMigrations, BASELINE_SCHEMA_HASH, canonicalSchemaHash, migrationRefusal,
} from './migrations.ts'

const fresh = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  return d
}

describe('Drizzle migration journal', () => {
  test('fresh migration retains the canonical hash produced by trunk applySchema', () => {
    const d = fresh()
    expect(canonicalSchemaHash(d)).toBe(BASELINE_SCHEMA_HASH)
    expect(BASELINE_SCHEMA_HASH).toBe('e5d0fa17fb7fb3087e4fda38a8cb31be0793fb4b68849ef1ae6eb08a127a9292')
    d.close()
  })

  test('migration-owned expression indexes are present', () => {
    const d = fresh()
    const indexes = d.query(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND name IN ('canon_pack_address','doc_address') ORDER BY name",
    ).all() as { name: string; sql: string }[]
    expect(indexes).toEqual([
      { name: 'canon_pack_address', sql: "CREATE UNIQUE INDEX canon_pack_address ON canon_pack(job, COALESCE(project, ''))" },
      { name: 'doc_address', sql: "CREATE UNIQUE INDEX doc_address ON doc(scope, COALESCE(subject, ''), slug)" },
    ])
    d.close()
  })

  test('every typed table and column has the migration NOT NULL and default shape', () => {
    const d = fresh()
    for (const value of Object.values(declared)) {
      if (!value || typeof value !== 'object' || !('getSQL' in value)) continue
      const table = value as SQLiteTable
      const name = getTableName(table)
      const config = getTableConfig(table)
      const actual = d.query(`PRAGMA table_info("${name}")`).all() as
        { name: string; notnull: number; dflt_value: string | null }[]
      expect(actual.length, name).toBe(config.columns.length)
      for (const column of config.columns) {
        const row = actual.find((candidate) => candidate.name === column.name)
        expect(row, `${name}.${column.name}`).toBeDefined()
        const primaryKeyNotNull = column.primary
        expect(Boolean(row!.notnull || primaryKeyNotNull), `${name}.${column.name} NOT NULL`)
          .toBe(column.notNull || primaryKeyNotNull)
        const expectedDefault = column.default === undefined ? null
          : typeof column.default === 'string' ? `'${column.default}'` : String(column.default)
        expect(row!.dflt_value, `${name}.${column.name} default`).toBe(expectedDefault)
      }
    }
    d.close()
  })

  test('a store behind the journal is refused with the lifecycle anchors', () => {
    const d = fresh()
    d.exec('DELETE FROM orch_migrations')
    expect(migrationRefusal(d)).toContain("invariant: Only the main checkout's binary migrates the store.")
    expect(migrationRefusal(d)).toContain('cleared by: orch migrate')
    d.close()
  })

  test('opening a behind-journal store refuses before an application query', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-behind-journal-'))
    const path = join(dir, 'behind.db')
    const empty = new Database(path); empty.close()
    const opened = Bun.spawnSync([process.execPath, join(import.meta.dir, 'cli.ts'), 'runs'], {
      env: { ...process.env, ORCH_DB: path, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(opened.exitCode).not.toBe(0)
    expect(opened.stderr.toString()).toContain("invariant: Only the main checkout's binary migrates the store.")
    expect(opened.stderr.toString()).toContain('cleared by: orch migrate')
    expect(opened.stderr.toString()).not.toContain('no such table: run')
    rmSync(dir, { recursive: true, force: true })
  })

  test('a matching pre-journal store adopts 0000 without rebuilding its schema', () => {
    const d = fresh()
    d.exec('DROP TABLE orch_migrations')
    const before = d.query(
      "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name",
    ).all()
    expect(applyMigrations(d)).toEqual(['0000_bright_sleepwalker'])
    const after = d.query(
      "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name<>'orch_migrations' ORDER BY type,name",
    ).all()
    expect(after).toEqual(before)
    d.close()
  })
})
