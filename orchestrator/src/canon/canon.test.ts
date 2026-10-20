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
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  applyMigrations,
  applyMigrationsBefore,
  canonicalSchemaHash,
  expectedSchemaHash,
  JOURNAL_WHEN_ORDER,
  MIGRATIONS_FOLDER,
  migrationJournal,
  migrationRefusal,
  readUserVersion,
} from '../database/migrations.ts'
import {
  migratedTestDatabase,
  prepareMigrationTestDatabases,
} from '../database/test-database.fixture.ts'

prepareMigrationTestDatabases()

const fresh = () => migratedTestDatabase()

const legacy = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  const baseline = migrationJournal()[0]!
  for (const statement of readFileSync(
    join(MIGRATIONS_FOLDER, `${baseline.tag}.sql`),
    'utf8',
  ).split('--> statement-breakpoint')) {
    if (statement.trim()) d.exec(statement)
  }
  return d
}

describe('Drizzle migration journal', () => {
  test('the baseline hash remains the first migration while a fresh store includes later migrations', () => {
    const d = fresh()
    expect(canonicalSchemaHash(d)).toBe(expectedSchemaHash())
    d.close()
  })

  test('migration-owned expression indexes are present', () => {
    const d = fresh()
    const indexes = d
      .query(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND name IN ('canon_pack_address','doc_address') ORDER BY name",
      )
      .all() as { name: string; sql: string }[]
    expect(indexes).toEqual([
      {
        name: 'canon_pack_address',
        sql: "CREATE UNIQUE INDEX canon_pack_address ON canon_pack(job,COALESCE(project,''))",
      },
      {
        name: 'doc_address',
        sql: "CREATE UNIQUE INDEX doc_address ON doc(scope,COALESCE(subject,''),COALESCE(owner,''),slug)",
      },
    ])
    d.close()
  })

  test('a store behind the journal is refused with the lifecycle anchors', () => {
    const d = fresh()
    d.exec('DELETE FROM orch_migrations')
    expect(migrationRefusal(d)).toContain(
      "invariant: Only the main checkout's binary migrates the store.",
    )
    expect(migrationRefusal(d)).toContain(`cleared by: ${PLATFORM_SLUG} machine migrate`)
    d.close()
  })

  test('a matching pre-journal store adopts 0000 and continues through later migrations', () => {
    const d = legacy()
    expect(applyMigrations(d)).toEqual(migrationJournal().map((entry) => entry.tag))
    expect(
      d.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='landing'").get(),
    ).toBeDefined()
    expect(
      d.query("SELECT name FROM pragma_table_info('run') WHERE name='spec_sha'").get(),
    ).toEqual({ name: 'spec_sha' })
    d.close()
  })

  test('a store migrated through 0001_landing_queue accepts later migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-through-0001-'))
    mkdirSync(join(dir, 'meta'))
    const through0001 = migrationJournal().slice(0, 2)
    for (const entry of through0001) {
      copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
    }
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: through0001,
      }),
    )
    const d = new Database(':memory:')
    expect(applyMigrations(d, dir)).toEqual(through0001.map((entry) => entry.tag))
    expect(applyMigrationsBefore(d, '0003_keep_tree')).toEqual(['0002_spec_sha'])
    expect(
      d.query("SELECT name FROM pragma_table_info('run') WHERE name='spec_sha'").get(),
    ).toEqual({ name: 'spec_sha' })
    d.close()
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

  test('legacy adoption continues through every later journal entry in one invocation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-adopt-forward-'))
    mkdirSync(join(dir, 'meta'))
    const baseline = migrationJournal()[0]!
    copyFileSync(join(MIGRATIONS_FOLDER, `${baseline.tag}.sql`), join(dir, `${baseline.tag}.sql`))
    writeFileSync(
      join(dir, '0001_after_adoption.sql'),
      'CREATE TABLE adopted_followup (id INTEGER PRIMARY KEY);\n',
    )
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [
          { ...baseline, version: '6', breakpoints: true },
          {
            idx: 1,
            version: '6',
            when: baseline.when + 1,
            tag: '0001_after_adoption',
            breakpoints: true,
          },
        ],
      }),
    )
    const d = legacy()
    expect(applyMigrations(d, dir)).toEqual([baseline.tag, '0001_after_adoption'])
    expect(
      d.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adopted_followup'").get(),
    ).toBeDefined()
    d.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('adoption names a rebuilt CHECK that the hash already includes', () => {
    // A baseline-only store: adoption compares to journal entry 0, and a store
    // built from the whole journal would list every later migration's CHECK as
    // unexpected ahead of the one this test rebuilds.
    const d = new Database(':memory:')
    d.exec('PRAGMA foreign_keys=ON')
    for (const statement of readFileSync(
      join(MIGRATIONS_FOLDER, `${migrationJournal()[0]!.tag}.sql`),
      'utf8',
    ).split('--> statement-breakpoint'))
      if (statement.trim()) d.exec(statement)
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
    writeFileSync(
      join(dir, '0000_collide.sql'),
      'CREATE TABLE boom (id INTEGER PRIMARY KEY);\n--> statement-breakpoint\nINSERT INTO boom (id) VALUES (1);\n--> statement-breakpoint\nINSERT INTO boom (id) VALUES (1);\n',
    )
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [{ idx: 0, version: '6', when: 1, tag: '0000_collide', breakpoints: true }],
      }),
    )
    const d = new Database(':memory:')
    expect(() => applyMigrations(d, dir)).toThrow()
    expect(
      d.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),
    ).toEqual([])
    expect(readUserVersion(d)).toBe(0)
    d.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a failed migration rolls back its DDL and journal record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-migration-rollback-'))
    mkdirSync(join(dir, 'meta'))
    writeFileSync(
      join(dir, '0000_failure.sql'),
      'CREATE TABLE should_rollback (id INTEGER);\n--> statement-breakpoint\nINSERT INTO absent VALUES (1);\n',
    )
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [{ idx: 0, version: '6', when: 1, tag: '0000_failure', breakpoints: true }],
      }),
    )
    const d = new Database(':memory:')
    const before = d
      .query('SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name')
      .all()
    expect(() => applyMigrations(d, dir)).toThrow()
    const after = d
      .query('SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name')
      .all()
    expect(after).toEqual(before)
    d.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a journal whose entries are idx-ordered but when-unordered is refused at load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-when-unordered-'))
    mkdirSync(join(dir, 'meta'))
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [
          { idx: 0, version: '6', when: 100, tag: '0000_first', breakpoints: true },
          { idx: 1, version: '6', when: 300, tag: '0001_later', breakpoints: true },
          { idx: 2, version: '6', when: 200, tag: '0002_earlier', breakpoints: true },
        ],
      }),
    )
    expect(() => migrationJournal(dir)).toThrow(
      'refusing to load a migration journal whose when values are not strictly increasing',
    )
    expect(() => migrationJournal(dir)).toThrow(`invariant: ${JOURNAL_WHEN_ORDER}`)
    expect(() => migrationJournal(dir)).toThrow('0001_later@300 then 0002_earlier@200')
    rmSync(dir, { recursive: true, force: true })
  })
})
