import { Database } from 'bun:sqlite'
import { describe, expect, setDefaultTimeout, test } from 'bun:test'

// Six of these tests spawn the orch CLI and apply the whole migration journal
// to scratch stores; each grew past bun's 5 s default as the journal gained
// entries (0001, 0002) and the inventory widened, and they timed out in a
// landing gate on 2026-09-07. The bound is sized to that work, like the CLI
// leg's; it is not a hidden widening.
setDefaultTimeout(30_000)
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTableName } from 'drizzle-orm'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import * as declared from './schema.ts'
import {
  applyMigrations, BASELINE_SCHEMA_HASH, baselineSchemaHash, canonicalSchemaHash,
  expectedSchemaHash,
  MIGRATIONS_FOLDER, migrationJournal, migrationRefusal,
} from './migrations.ts'

const fresh = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  return d
}

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

describe('Drizzle migration journal', () => {
  test('the baseline hash remains the first migration while a fresh store includes later migrations', () => {
    const d = fresh()
    expect(BASELINE_SCHEMA_HASH).toBe(baselineSchemaHash())
    expect(BASELINE_SCHEMA_HASH).toBe('d1e24ee1a94d0783dc00aab771997283bdcb58322bb784b6f375eb1bae982991')
    const comparison = fresh()
    expect(canonicalSchemaHash(d)).toBe(canonicalSchemaHash(comparison))
    expect(canonicalSchemaHash(d)).not.toBe(BASELINE_SCHEMA_HASH)
    expect(canonicalSchemaHash(d)).toBe(expectedSchemaHash())
    comparison.close()
    d.close()
  })

  test('doctor matches the complete journal while preserving baseline adoption', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-doctor-current-'))
    const currentPath = join(dir, 'current.db')
    const current = new Database(currentPath)
    applyMigrations(current)
    current.close()
    const doctor = Bun.spawnSync([process.execPath, join(import.meta.dir, 'cli.ts'), 'doctor'], {
      env: { ...process.env, ORCH_DB: currentPath, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0)
    expect(doctor.stdout.toString()).toContain('schema hash    match')

    const legacyStore = legacy()
    expect(canonicalSchemaHash(legacyStore)).toBe(BASELINE_SCHEMA_HASH)
    expect(applyMigrations(legacyStore)).toEqual([
      '0000_bright_sleepwalker', '0001_landing_queue', '0002_spec_sha', '0003_keep_tree', '0004_lens_catalogue',
    ])
    legacyStore.close()
    rmSync(dir, { recursive: true, force: true })
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

  test('a matching pre-journal store adopts 0000 and continues through later migrations', () => {
    const d = legacy()
    expect(applyMigrations(d)).toEqual([
      '0000_bright_sleepwalker', '0001_landing_queue', '0002_spec_sha', '0003_keep_tree', '0004_lens_catalogue',
    ])
    expect(d.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='landing'").get())
      .toBeDefined()
    expect(d.query("SELECT name FROM pragma_table_info('run') WHERE name='spec_sha'").get())
      .toEqual({ name: 'spec_sha' })
    d.close()
  })

  test('a store migrated through 0001_landing_queue accepts later migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-through-0001-'))
    mkdirSync(join(dir, 'meta'))
    const through0001 = migrationJournal().slice(0, 2)
    for (const entry of through0001) {
      copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
    }
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({
      version: '7', dialect: 'sqlite', entries: through0001,
    }))
    const d = new Database(':memory:')
    expect(applyMigrations(d, dir)).toEqual(['0000_bright_sleepwalker', '0001_landing_queue'])
    expect(applyMigrations(d)).toEqual(['0002_spec_sha', '0003_keep_tree', '0004_lens_catalogue'])
    expect(d.query("SELECT name FROM pragma_table_info('run') WHERE name='spec_sha'").get())
      .toEqual({ name: 'spec_sha' })
    d.close()
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
    const doctor = Bun.spawnSync([process.execPath, join(import.meta.dir, 'cli.ts'), 'doctor'], {
      env: { ...process.env, ORCH_DB: doctorPath, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0)
    expect(doctor.stdout.toString()).toContain('schema hash    DRIFT')
    rmSync(dir, { recursive: true, force: true })
  })

  test('an added index refuses baseline adoption with the index difference', () => {
    const d = legacy()
    d.exec('CREATE INDEX unexpected_run_agent ON run(agent)')
    expect(() => applyMigrations(d)).toThrow('refusing to adopt migration baseline')
    try {
      applyMigrations(d)
    } catch (error) {
      const message = String(error)
      expect(message).toContain('unexpected columns: none')
      expect(message).toContain('unexpected indexes: run.unexpected_run_agent')
    }
    d.close()
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
    const d = legacy()
    expect(applyMigrations(d, dir)).toEqual([baseline.tag, '0001_after_adoption'])
    expect(d.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adopted_followup'").get())
      .toBeDefined()
    d.close()
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
    const doctor = Bun.spawnSync([process.execPath, join(import.meta.dir, 'cli.ts'), 'doctor'], {
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
    const doctor = Bun.spawnSync([process.execPath, join(import.meta.dir, 'cli.ts'), 'doctor'], {
      env: { ...process.env, ORCH_DB: doctorPath, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0)
    expect(doctor.stdout.toString()).toContain('schema hash    DRIFT')
    rmSync(dir, { recursive: true, force: true })
  })

  test('adoption names a rebuilt CHECK that the hash already includes', () => {
    // A baseline-only store: adoption compares to journal entry 0, and a store
    // built from the whole journal would list every later migration's CHECK as
    // unexpected ahead of the one this test rebuilds.
    const d = new Database(':memory:')
    d.exec('PRAGMA foreign_keys=ON')
    for (const statement of readFileSync(join(MIGRATIONS_FOLDER, `${migrationJournal()[0]!.tag}.sql`), 'utf8')
      .split('--> statement-breakpoint')) if (statement.trim()) d.exec(statement)
    d.exec(`DROP TABLE session_seen;
      CREATE TABLE session_seen (
        session_id TEXT PRIMARY KEY,
        last_seen TEXT NOT NULL,
        CHECK (length(session_id) > 0)
      )`)
    expect(() => applyMigrations(d)).toThrow('refusing to adopt migration baseline')
    try {
      applyMigrations(d)
    } catch (error) {
      const message = String(error)
      expect(message).toContain('unexpected checks: check session_seen length(session_id)>0')
      expect(message).toContain('missing checks: none')
    }
    d.close()
  })

  test('adoption names a rebuilt foreign key that the hash already includes', () => {
    const missing =
      'foreign-key {"table":"blocker","id":0,"sequence":0,"targetTable":"run","from":"run_id","to":"id","onUpdate":"no action","onDelete":"cascade","match":"none"}'
    const unexpected =
      'foreign-key {"table":"blocker","id":0,"sequence":0,"targetTable":"run","from":"run_id","to":"id","onUpdate":"no action","onDelete":"set null","match":"none"}'
    const d = fresh()
    d.exec('DROP TABLE orch_migrations')
    d.exec(`DROP TABLE blocker;
      CREATE TABLE blocker (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE SET NULL,
        at TEXT NOT NULL,
        what TEXT NOT NULL,
        why TEXT,
        impact TEXT,
        source TEXT NOT NULL CHECK (source IN ('declared','detected')),
        kind TEXT
      );
      CREATE INDEX blocker_kind ON blocker(kind, at);
      CREATE INDEX blocker_run ON blocker(run_id);`)
    expect(() => applyMigrations(d)).toThrow('refusing to adopt migration baseline')
    try {
      applyMigrations(d)
    } catch (error) {
      const message = String(error)
      expect(message).toContain(`missing foreign-keys: ${missing}`)
      expect(message).toContain(`unexpected foreign-keys: ${unexpected}`)
    }
    d.close()
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
