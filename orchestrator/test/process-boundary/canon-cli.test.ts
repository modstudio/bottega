import { Database } from 'bun:sqlite'
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyMigrations, BASELINE_SCHEMA_HASH, baselineSchemaHash, canonicalSchemaHash,
  expectedSchemaHash, MIGRATIONS_FOLDER, migrationJournal, schemaVersionLabel,
} from '../../src/migrations.ts'

setDefaultTimeout(30_000)

const legacy = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  const baseline = migrationJournal()[0]!
  for (const statement of readFileSync(join(MIGRATIONS_FOLDER, `${baseline.tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')) {
    if (statement.trim()) d.exec(statement)
  }
  return d
}

describe('migration CLI boundaries', () => {
test('doctor matches the complete journal while preserving baseline adoption', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-doctor-current-'))
    const currentPath = join(dir, 'current.db')
    const current = new Database(currentPath)
    applyMigrations(current)
    current.close()
    const doctor = Bun.spawnSync([process.execPath, new URL('../../src/orch.ts', import.meta.url).pathname, 'doctor'], {
      env: { ...process.env, ORCH_DB: currentPath, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0)
    expect(doctor.stdout.toString()).toContain('schema hash    match')

    const legacyStore = legacy()
    expect(canonicalSchemaHash(legacyStore)).toBe(BASELINE_SCHEMA_HASH)
    expect(applyMigrations(legacyStore)).toEqual(migrationJournal().map((entry) => entry.tag))
    legacyStore.close()
    rmSync(dir, { recursive: true, force: true })
  })

test('opening a behind-journal store refuses before an application query', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-behind-journal-'))
    const path = join(dir, 'behind.db')
    const empty = new Database(path); empty.close()
    const opened = Bun.spawnSync([process.execPath, new URL('../../src/orch.ts', import.meta.url).pathname, 'runs'], {
      env: { ...process.env, ORCH_DB: path, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(opened.exitCode).not.toBe(0)
    expect(opened.stderr.toString()).toContain("invariant: Only the main checkout's binary migrates the store.")
    expect(opened.stderr.toString()).toContain('cleared by: orch migrate')
    expect(opened.stderr.toString()).not.toContain('no such table: run')
    rmSync(dir, { recursive: true, force: true })
  })

test('live DDL drift refuses adoption with hashes and shape differences, and doctor reports it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-ddl-drift-'))
    const path = join(dir, 'drift.db')
    const d = new Database(path)
    d.exec('PRAGMA foreign_keys=ON')
    for (const statement of readFileSync(join(MIGRATIONS_FOLDER, `${migrationJournal()[0]!.tag}.sql`), 'utf8')
      .split('--> statement-breakpoint')) if (statement.trim()) d.exec(statement)
    d.exec('ALTER TABLE run ADD COLUMN x TEXT')
    expect(canonicalSchemaHash(d)).not.toBe(BASELINE_SCHEMA_HASH)
    expect(() => applyMigrations(d)).toThrow('refusing to adopt migration baseline')
    try {
      applyMigrations(d)
    } catch (error) {
      const message = String(error)
      expect(message).toContain(`stored hash: ${canonicalSchemaHash(d)}`)
      expect(message).toContain(`expected hash: ${BASELINE_SCHEMA_HASH}`)
      expect(message).toContain('run.x text notnull=0 default=NULL pk=0')
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
    const doctor = Bun.spawnSync([process.execPath, new URL('../../src/orch.ts', import.meta.url).pathname, 'doctor'], {
      env: { ...process.env, ORCH_DB: doctorPath, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0)
    expect(doctor.stdout.toString()).toContain('schema hash    DRIFT')
    rmSync(dir, { recursive: true, force: true })
  })

test('ordinary index direction drift refuses adoption and doctor reports drift', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-index-direction-drift-'))
    const path = join(dir, 'adoption.db')
    const d = new Database(path)
    for (const statement of readFileSync(join(MIGRATIONS_FOLDER, `${migrationJournal()[0]!.tag}.sql`), 'utf8')
      .split('--> statement-breakpoint')) if (statement.trim()) d.exec(statement)
    d.exec(`DROP INDEX run_job_agent;
      CREATE INDEX run_job_agent ON run(job DESC, agent);
    `)
    expect(canonicalSchemaHash(d)).not.toBe(BASELINE_SCHEMA_HASH)
    expect(() => applyMigrations(d)).toThrow('refusing to adopt migration baseline')
    try {
      applyMigrations(d)
    } catch (error) {
      expect(String(error)).toContain('unexpected indexes: run.run_job_agent')
    }
    d.close()

    const doctorPath = join(dir, 'doctor.db')
    const doctorStore = new Database(doctorPath)
    applyMigrations(doctorStore)
    doctorStore.exec(`DROP INDEX run_job_agent;
      CREATE INDEX run_job_agent ON run(job DESC, agent)`)
    doctorStore.close()
    const doctor = Bun.spawnSync([process.execPath, new URL('../../src/orch.ts', import.meta.url).pathname, 'doctor'], {
      env: { ...process.env, ORCH_DB: doctorPath, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0)
    expect(doctor.stdout.toString()).toContain('schema hash    DRIFT')
    rmSync(dir, { recursive: true, force: true })
  })

test('a stray trigger refuses adoption and doctor reports DRIFT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-stray-trigger-'))
    const path = join(dir, 'adopt.db')
    const d = new Database(path)
    applyMigrations(d)
    d.exec(`CREATE TRIGGER project_shadow AFTER INSERT ON project BEGIN SELECT 1; END`)
    d.exec('DROP TABLE orch_migrations')
    expect(() => applyMigrations(d)).toThrow('refusing to adopt migration baseline')
    try {
      applyMigrations(d)
    } catch (error) {
      const message = String(error)
      expect(message).toContain('unexpected triggers:')
      expect(message).toContain('project_shadow')
      expect(message).not.toContain('unexpected triggers: none')
    }
    d.close()
    const doctorPath = join(dir, 'doctor.db')
    const doctorStore = new Database(doctorPath)
    applyMigrations(doctorStore)
    doctorStore.exec(`CREATE TRIGGER project_shadow AFTER INSERT ON project BEGIN SELECT 1; END`)
    doctorStore.close()
    const doctor = Bun.spawnSync([process.execPath, new URL('../../src/orch.ts', import.meta.url).pathname, 'doctor'], {
      env: { ...process.env, ORCH_DB: doctorPath, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0)
    expect(doctor.stdout.toString()).toContain('schema hash    DRIFT')
    rmSync(dir, { recursive: true, force: true })
  })

test('a stray view refuses adoption and doctor reports DRIFT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-stray-view-'))
    const path = join(dir, 'adopt.db')
    const d = new Database(path)
    applyMigrations(d)
    d.exec(`CREATE VIEW project_names AS SELECT name FROM project`)
    d.exec('DROP TABLE orch_migrations')
    expect(() => applyMigrations(d)).toThrow('refusing to adopt migration baseline')
    try {
      applyMigrations(d)
    } catch (error) {
      const message = String(error)
      expect(message).toContain('unexpected views:')
      expect(message).toContain('project_names')
      expect(message).not.toContain('unexpected views: none')
    }
    d.close()
    const doctorPath = join(dir, 'doctor.db')
    const doctorStore = new Database(doctorPath)
    applyMigrations(doctorStore)
    doctorStore.exec(`CREATE VIEW project_names AS SELECT name FROM project`)
    doctorStore.close()
    const doctor = Bun.spawnSync([process.execPath, new URL('../../src/orch.ts', import.meta.url).pathname, 'doctor'], {
      env: { ...process.env, ORCH_DB: doctorPath, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0)
    expect(doctor.stdout.toString()).toContain('schema hash    DRIFT')
    rmSync(dir, { recursive: true, force: true })
  })

test('doctor reports unstamped for user_version 0 rather than behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-unstamped-'))
    const path = join(dir, 'store.db')
    const d = new Database(path)
    applyMigrations(d)
    d.exec('PRAGMA user_version = 0')
    expect(schemaVersionLabel(d)).toBe('unstamped')
    d.close()
    const doctor = Bun.spawnSync([process.execPath, new URL('../../src/orch.ts', import.meta.url).pathname, 'doctor'], {
      env: { ...process.env, ORCH_DB: path, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0)
    expect(doctor.stdout.toString()).toMatch(/^schema version unstamped$/m)
    rmSync(dir, { recursive: true, force: true })
  })
})
