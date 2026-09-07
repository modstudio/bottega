import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTableName } from 'drizzle-orm'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import * as declared from './schema.ts'
import {
  applyMigrations, BASELINE_SCHEMA_HASH, baselineSchemaHash, canonicalSchemaHash,
  MIGRATIONS_FOLDER, migrationJournal, migrationRefusal,
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
    expect(BASELINE_SCHEMA_HASH).toBe(baselineSchemaHash())
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

  test('live DDL drift refuses adoption with hashes and shape differences, and doctor reports it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-ddl-drift-'))
    const path = join(dir, 'drift.db')
    const d = new Database(path)
    applyMigrations(d)
    d.exec('DROP TABLE orch_migrations; ALTER TABLE run ADD COLUMN x TEXT')
    expect(canonicalSchemaHash(d)).not.toBe(BASELINE_SCHEMA_HASH)
    expect(() => applyMigrations(d)).toThrow('refusing to adopt migration baseline')
    try {
      applyMigrations(d)
    } catch (error) {
      const message = String(error)
      expect(message).toContain(`stored hash: ${canonicalSchemaHash(d)}`)
      expect(message).toContain(`expected hash: ${BASELINE_SCHEMA_HASH}`)
      expect(message).toContain('unexpected columns: run.x TEXT')
      expect(message).toContain('missing indexes: none')
      expect(message).toContain('unexpected indexes: none')
      expect(message).toContain("back up the store and run the old binary's open once")
    }
    d.close()
    const doctorPath = join(dir, 'doctor-drift.db')
    const doctorStore = new Database(doctorPath)
    applyMigrations(doctorStore)
    doctorStore.exec('ALTER TABLE run ADD COLUMN x TEXT')
    doctorStore.close()
    const doctor = Bun.spawnSync([process.execPath, join(import.meta.dir, 'cli.ts'), 'doctor'], {
      env: { ...process.env, ORCH_DB: doctorPath, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0)
    expect(doctor.stdout.toString()).toContain('schema hash    DRIFT')
    rmSync(dir, { recursive: true, force: true })
  })

  test('legacy adoption continues through every later journal entry in one invocation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-adopt-forward-'))
    mkdirSync(join(dir, 'meta'))
    const baseline = migrationJournal()[0]!
    copyFileSync(join(MIGRATIONS_FOLDER, `${baseline.tag}.sql`), join(dir, `${baseline.tag}.sql`))
    writeFileSync(join(dir, '0001_after_adoption.sql'), 'CREATE TABLE adopted_followup (id INTEGER PRIMARY KEY);\n')
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({
      version: '7', dialect: 'sqlite', entries: [
        { ...baseline, version: '6', breakpoints: true },
        { idx: 1, version: '6', when: baseline.when + 1, tag: '0001_after_adoption', breakpoints: true },
      ],
    }))
    const d = fresh()
    d.exec('DROP TABLE orch_migrations')
    expect(applyMigrations(d, dir)).toEqual([baseline.tag, '0001_after_adoption'])
    expect(d.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adopted_followup'").get())
      .toBeDefined()
    d.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a failed migration rolls back its DDL and journal record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-migration-rollback-'))
    mkdirSync(join(dir, 'meta'))
    writeFileSync(join(dir, '0000_failure.sql'),
      'CREATE TABLE should_rollback (id INTEGER);\n--> statement-breakpoint\nINSERT INTO absent VALUES (1);\n')
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({
      version: '7', dialect: 'sqlite', entries: [
        { idx: 0, version: '6', when: 1, tag: '0000_failure', breakpoints: true },
      ],
    }))
    const d = new Database(':memory:')
    const before = d.query("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all()
    expect(() => applyMigrations(d, dir)).toThrow()
    const after = d.query("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all()
    expect(after).toEqual(before)
    d.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
