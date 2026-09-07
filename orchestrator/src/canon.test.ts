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
  CONNECTION_SCHEMA_INVARIANT, expectedSchemaHash, JOURNAL_WHEN_ORDER, journalLength,
  MIGRATIONS_FOLDER, migrationJournal, migrationRefusal, readUserVersion,
  SCHEMA_LOCK_TABLE, schemaVersionLabel, splitMigrationSource,
} from './migrations.ts'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { db, enableSchemaReload, writeTransaction } from './db.ts'
import { diffCarriesMigrationJournal } from './landing.ts'

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
      '0000_bright_sleepwalker', '0001_landing_queue', '0002_spec_sha', '0003_keep_tree', '0004_lens_catalogue', '0005_agent_registry', '0006_project_id_backfill', '0006_contention',
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
      '0000_bright_sleepwalker', '0001_landing_queue', '0002_spec_sha', '0003_keep_tree', '0004_lens_catalogue', '0005_agent_registry', '0006_project_id_backfill', '0006_contention',
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
    expect(applyMigrations(d)).toEqual(['0002_spec_sha', '0003_keep_tree', '0004_lens_catalogue', '0005_agent_registry', '0006_project_id_backfill', '0006_contention'])
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

  test('a colliding later INSERT rolls back tables, user_version, journal and lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-pk-collide-'))
    mkdirSync(join(dir, 'meta'))
    writeFileSync(join(dir, '0000_collide.sql'),
      'CREATE TABLE boom (id INTEGER PRIMARY KEY);\n--> statement-breakpoint\nINSERT INTO boom (id) VALUES (1);\n--> statement-breakpoint\nINSERT INTO boom (id) VALUES (1);\n')
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({
      version: '7', dialect: 'sqlite', entries: [
        { idx: 0, version: '6', when: 1, tag: '0000_collide', breakpoints: true },
      ],
    }))
    const d = new Database(':memory:')
    expect(() => applyMigrations(d, dir)).toThrow()
    expect(d.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).toEqual([])
    expect(readUserVersion(d)).toBe(0)
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

  test('a journal whose entries are idx-ordered but when-unordered is refused at load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-when-unordered-'))
    mkdirSync(join(dir, 'meta'))
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({
      version: '7', dialect: 'sqlite', entries: [
        { idx: 0, version: '6', when: 100, tag: '0000_first', breakpoints: true },
        { idx: 1, version: '6', when: 300, tag: '0001_later', breakpoints: true },
        { idx: 2, version: '6', when: 200, tag: '0002_earlier', breakpoints: true },
      ],
    }))
    expect(() => migrationJournal(dir)).toThrow(
      'refusing to load a migration journal whose when values are not strictly increasing',
    )
    expect(() => migrationJournal(dir)).toThrow(`invariant: ${JOURNAL_WHEN_ORDER}`)
    expect(() => migrationJournal(dir)).toThrow('0001_later@300 then 0002_earlier@200')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('schema coexistence', () => {
  test('the migrator stamps user_version to the journal length even when nothing is pending', () => {
    const d = fresh()
    expect(readUserVersion(d)).toBe(journalLength())
    expect(schemaVersionLabel(d)).toBe(String(journalLength()))
    expect(applyMigrations(d)).toEqual([])
    expect(readUserVersion(d)).toBe(journalLength())
    d.close()
  })

  test('doctor reports unstamped for user_version 0 rather than behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-unstamped-'))
    const path = join(dir, 'store.db')
    const d = new Database(path)
    applyMigrations(d)
    d.exec('PRAGMA user_version = 0')
    expect(schemaVersionLabel(d)).toBe('unstamped')
    d.close()
    const doctor = Bun.spawnSync([process.execPath, join(import.meta.dir, 'cli.ts'), 'doctor'], {
      env: { ...process.env, ORCH_DB: path, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0)
    expect(doctor.stdout.toString()).toMatch(/^schema version unstamped$/m)
    rmSync(dir, { recursive: true, force: true })
  })

  test('a connection opened before a migration refuses its next write', () => {
    db()
    const other = new Database(process.env.ORCH_DB!)
    other.exec(`PRAGMA user_version = ${journalLength() + 1}`)
    other.close()
    expect(() => writeTransaction(() => {
      db().query('UPDATE project SET name = name WHERE 0').run()
    })).toThrow(`invariant: ${CONNECTION_SCHEMA_INVARIANT}`)
    try {
      writeTransaction(() => { db().query('UPDATE project SET name = name WHERE 0').run() })
    } catch (error) {
      expect(String(error)).toContain('cleared by: restart this process after orch migrate')
    }
  })

  test('review project_id backfill requires aliased lens repos to collapse to one project', () => {
    const d = fresh()
    d.query(`INSERT INTO project (name, path, canon, settings) VALUES (?, '/p', 1, '{}')`).run(PLATFORM_SLUG)
    d.query(`INSERT INTO project (name, path, canon, settings) VALUES ('starship', '/s', 1, '{}')`).run()
    d.query(`INSERT INTO project (name, path, canon, settings) VALUES ('alephbeis', '/a', 1, '{}')`).run()
    const platformId = (d.query('SELECT id FROM project WHERE name=?').get(PLATFORM_SLUG) as { id: number }).id
    const starship = (d.query("SELECT id FROM project WHERE name='starship'").get() as { id: number }).id
    const insertRun = (repo: string, projectId: number) =>
      (d.query(
        `INSERT INTO run (started_at, agent, job, repo, project_id, prompt_sha, prompt_bytes, prompt_head, status)
         VALUES ('t', 'a', 'review-lens', ?, ?, 'sha', 1, 'h', 'ok') RETURNING id`,
      ).get(repo, projectId) as { id: number }).id
    const mixed = (d.query("INSERT INTO review (recorded_at) VALUES ('t') RETURNING id").get() as { id: number }).id
    const aliased = (d.query("INSERT INTO review (recorded_at) VALUES ('t') RETURNING id").get() as { id: number }).id
    const mixedA = insertRun('starship', starship)
    const mixedB = insertRun('alephbeis', starship)
    const aliasA = insertRun(PLATFORM_SLUG, platformId)
    const aliasB = insertRun('devbox', platformId)
    const lens = (reviewId: number, runId: number, name: string) => {
      d.query(
        `INSERT INTO review_lens (review_id, run_id, lens, agent, standards_read, files_covered, commands_run, could_not_verify)
         VALUES (?, ?, ?, 'codex', '[]', '[]', '[]', '[]')`,
      ).run(reviewId, runId, name)
    }
    lens(mixed, mixedA, 'a')
    lens(mixed, mixedB, 'b')
    lens(aliased, aliasA, 'a')
    lens(aliased, aliasB, 'b')
    expect(applyMigrations(d)).toEqual([])
    expect(d.query('SELECT project_id FROM review WHERE id=?').get(mixed)).toEqual({ project_id: null })
    expect(d.query('SELECT project_id FROM review WHERE id=?').get(aliased)).toEqual({ project_id: platformId })
    d.close()
  })

  test('a pre-migration row is repaired by the next migrate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-backfill-repair-'))
    mkdirSync(join(dir, 'meta'))
    const through0005 = migrationJournal().slice(0, 6)
    for (const entry of through0005) {
      copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
    }
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({
      version: '7', dialect: 'sqlite', entries: through0005,
    }))
    const d = new Database(':memory:')
    d.exec('PRAGMA foreign_keys=ON')
    applyMigrations(d, dir)
    d.query(`INSERT INTO project (name, path, canon, settings) VALUES ('widget', '/tmp/widget', 1, '{}')`).run()
    d.query(
      `INSERT INTO run (started_at, agent, job, repo, prompt_sha, prompt_bytes, prompt_head, status)
       VALUES ('t', 'a', 'implement', 'widget', 'sha', 1, 'h', 'ok')`,
    ).run()
    expect(d.query('SELECT project_id FROM run').get()).toEqual({ project_id: null })
    expect(applyMigrations(d)).toEqual(['0006_project_id_backfill', '0006_contention'])
    const row = d.query(
      'SELECT project_id, (SELECT id FROM project WHERE name=?) expected FROM run',
    ).get('widget') as { project_id: number; expected: number }
    expect(row.project_id).toBe(row.expected)
    d.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('two concurrent migrates serialise on the schema lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-concurrent-migrate-'))
    const path = join(dir, 'store.db')
    const run = () => {
      const d = new Database(path)
      const versions = applyMigrations(d)
      d.close()
      return versions
    }
    const [first, second] = await Promise.all([Promise.resolve().then(run), Promise.resolve().then(run)])
    expect([...first, ...second].sort()).toEqual(migrationJournal().map((entry) => entry.tag).sort())
    const seen = new Database(path)
    expect(seen.query(
      `SELECT version FROM ${'orch_migrations'} GROUP BY version HAVING COUNT(*) > 1`,
    ).all()).toEqual([])
    expect(readUserVersion(seen)).toBe(journalLength())
    expect(seen.query(`SELECT 1 FROM sqlite_master WHERE name=?`).get(SCHEMA_LOCK_TABLE)).toBeDefined()
    seen.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('the ahead ceiling keys on applied count, not the last entry when', () => {
    const d = fresh()
    const existing = d.query(
      'SELECT hash, created_at, version FROM orch_migrations LIMIT 1',
    ).get() as { hash: string; created_at: number; version: string }
    d.query('INSERT INTO orch_migrations (hash, created_at, version) VALUES (?, ?, ?)').run(
      existing.hash, existing.created_at, existing.version,
    )
    expect(migrationRefusal(d)).toContain('refusing to open a store ahead')
    d.close()
  })

  test('backfill blocks are stripped from the hashed DDL and re-run every migrate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-backfill-block-'))
    mkdirSync(join(dir, 'meta'))
    writeFileSync(join(dir, '0000_base.sql'), 'CREATE TABLE item (id INTEGER PRIMARY KEY, n INTEGER);\n')
    writeFileSync(join(dir, '0001_fill.sql'),
      '-- note\n-- BACKFILL\nINSERT INTO item (n) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM item WHERE n=1);\n-- /BACKFILL\n')
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({
      version: '7', dialect: 'sqlite', entries: [
        { idx: 0, version: '6', when: 1, tag: '0000_base', breakpoints: true },
        { idx: 1, version: '6', when: 2, tag: '0001_fill', breakpoints: true },
      ],
    }))
    expect(splitMigrationSource(readFileSync(join(dir, '0001_fill.sql'), 'utf8')).ddl).toBe('-- note\n')
    const d = new Database(':memory:')
    expect(applyMigrations(d, dir)).toEqual(['0000_base', '0001_fill'])
    expect(d.query('SELECT COUNT(*) n FROM item').get()).toEqual({ n: 1 })
    d.exec('DELETE FROM item')
    expect(applyMigrations(d, dir)).toEqual([])
    expect(d.query('SELECT COUNT(*) n FROM item').get()).toEqual({ n: 1 })
    expect(readUserVersion(d)).toBe(2)
    d.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('diffCarriesMigrationJournal is true only for concern journal paths', () => {
    expect(diffCarriesMigrationJournal(['orchestrator/src/db.ts'])).toBe(false)
    expect(diffCarriesMigrationJournal(['orchestrator/migrations/0006_project_id_backfill.sql'])).toBe(true)
    expect(diffCarriesMigrationJournal(['hub/migrations/meta/_journal.json'])).toBe(true)
  })

  test('reload mode re-prepares instead of refusing a write after user_version changes', () => {
    const seen: Array<[number | null, number]> = []
    db()
    enableSchemaReload((from, to) => { seen.push([from, to]) })
    const other = new Database(process.env.ORCH_DB!)
    const next = journalLength() + 1
    other.exec(`PRAGMA user_version = ${next}`)
    other.close()
    writeTransaction(() => { db().query('UPDATE project SET name = name WHERE 0').run() })
    expect(seen).toEqual([[journalLength(), next]])
  })

  test('writeTransaction after reload writes on the new handle, not the closed one', () => {
    enableSchemaReload(() => {})
    const held = db()
    const other = new Database(process.env.ORCH_DB!)
    other.exec(`PRAGMA user_version = ${journalLength() + 1}`)
    other.close()
    writeTransaction(() => {
      db().query("INSERT INTO project (name, path, canon, settings) VALUES ('held-reload', '/held', 1, '{}')").run()
    }, held)
    expect(() => held.query('SELECT 1').get()).toThrow('closed')
    expect(db().query("SELECT name FROM project WHERE name='held-reload'").get()).toEqual({ name: 'held-reload' })
  })
})

describe('stripSqlComments feeds exec text that keeps quoted comment markers', () => {
  test('a quoted -- or /* survives, real comments go, and a trailing comment cannot swallow a failure', () => {
    const { stripSqlComments } = require('./migrations.ts') as typeof import('./migrations.ts')
    expect(stripSqlComments("INSERT INTO t (v) VALUES ('a -- b'); -- seed\n")).toBe("INSERT INTO t (v) VALUES ('a -- b'); \n")
    expect(stripSqlComments("SELECT '/* not a comment */' /* real */ FROM t")).toBe("SELECT '/* not a comment */'  FROM t")
    expect(stripSqlComments("SELECT 'it''s -- fine' FROM t")).toBe("SELECT 'it''s -- fine' FROM t")
    expect(stripSqlComments("INSERT INTO boom (id) VALUES (1); -- again").trim()).toBe('INSERT INTO boom (id) VALUES (1);')
  })
})
