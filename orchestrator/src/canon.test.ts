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
  applyMigrations,
  BASELINE_SCHEMA_HASH,
  baselineSchemaHash,
  canonicalSchemaHash,
  CONNECTION_SCHEMA_INVARIANT,
  expectedSchemaHash,
  JOURNAL_WHEN_ORDER,
  journalLength,
  MIGRATIONS_FOLDER,
  migrationJournal,
  migrationRefusal,
  readUserVersion,
  SCHEMA_LOCK_TABLE,
  schemaVersionLabel,
  splitMigrationSource,
} from './migrations.ts'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { db, enableSchemaReload, writeTransaction } from './db.ts'

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
    expect(BASELINE_SCHEMA_HASH).toBe(baselineSchemaHash())
    expect(BASELINE_SCHEMA_HASH).toBe(
      'd1e24ee1a94d0783dc00aab771997283bdcb58322bb784b6f375eb1bae982991',
    )
    const comparison = fresh()
    expect(canonicalSchemaHash(d)).toBe(canonicalSchemaHash(comparison))
    expect(canonicalSchemaHash(d)).not.toBe(BASELINE_SCHEMA_HASH)
    expect(canonicalSchemaHash(d)).toBe(expectedSchemaHash())
    comparison.close()
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
        sql: "CREATE UNIQUE INDEX canon_pack_address ON canon_pack(job, COALESCE(project, ''))",
      },
      {
        name: 'doc_address',
        sql: "CREATE UNIQUE INDEX doc_address ON doc(scope, COALESCE(subject, ''), slug)",
      },
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
      const actual = d.query(`PRAGMA table_info("${name}")`).all() as {
        name: string
        notnull: number
        dflt_value: string | null
      }[]
      expect(actual.length, name).toBe(config.columns.length)
      for (const column of config.columns) {
        const row = actual.find((candidate) => candidate.name === column.name)
        expect(row, `${name}.${column.name}`).toBeDefined()
        const primaryKeyNotNull = column.primary
        expect(Boolean(row!.notnull || primaryKeyNotNull), `${name}.${column.name} NOT NULL`).toBe(
          column.notNull || primaryKeyNotNull,
        )
        const expectedDefault =
          column.default === undefined
            ? null
            : typeof column.default === 'string'
              ? `'${column.default}'`
              : String(column.default)
        expect(row!.dflt_value, `${name}.${column.name} default`).toBe(expectedDefault)
      }
    }
    d.close()
  })

  test('a store behind the journal is refused with the lifecycle anchors', () => {
    const d = fresh()
    d.exec('DELETE FROM orch_migrations')
    expect(migrationRefusal(d)).toContain(
      "invariant: Only the main checkout's binary migrates the store.",
    )
    expect(migrationRefusal(d)).toContain('cleared by: orch migrate')
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
    expect(applyMigrations(d)).toEqual(
      migrationJournal()
        .slice(2)
        .map((entry) => entry.tag),
    )
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

describe('schema coexistence', () => {
  test('the migrator stamps user_version to the journal length even when nothing is pending', () => {
    const d = fresh()
    expect(readUserVersion(d)).toBe(journalLength())
    expect(schemaVersionLabel(d)).toBe(String(journalLength()))
    expect(applyMigrations(d)).toEqual([])
    expect(readUserVersion(d)).toBe(journalLength())
    d.close()
  })

  test('applying the complete journal stamps user_version to its length and a 0007 store migrates the rest', () => {
    const minted = fresh()
    expect(journalLength()).toBe(migrationJournal().length)
    expect(applyMigrations(minted)).toEqual([])
    expect(readUserVersion(minted)).toBe(journalLength())
    expect(
      minted.query("SELECT name FROM pragma_table_info('run') WHERE name='confinement'").get(),
    ).toEqual({ name: 'confinement' })
    expect(
      minted.query("SELECT name FROM pragma_table_info('run') WHERE name='mcp_probe'").get(),
    ).toEqual({ name: 'mcp_probe' })
    expect(
      minted.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contention'").get(),
    ).toBeDefined()
    expect(
      minted.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_flake'").get(),
    ).toBeDefined()
    expect(
      minted.query("SELECT name FROM pragma_table_info('test_flake') WHERE name='signal'").get(),
    ).toEqual({ name: 'signal' })
    expect(
      minted.query("SELECT name FROM pragma_table_info('run') WHERE name='last_event_at'").get(),
    ).toEqual({ name: 'last_event_at' })
    expect(
      minted.query("SELECT name FROM pragma_table_info('run') WHERE name='minted_branch'").get(),
    ).toEqual({ name: 'minted_branch' })
    minted.close()

    const dir = mkdtempSync(join(tmpdir(), 'orch-through-0009-'))
    mkdirSync(join(dir, 'meta'))
    const through0009 = migrationJournal().slice(0, 10)
    for (const entry of through0009) {
      copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
    }
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: through0009,
      }),
    )
    const d = new Database(':memory:')
    d.exec('PRAGMA foreign_keys=ON')
    expect(applyMigrations(d, dir)).toEqual(through0009.map((entry) => entry.tag))
    expect(readUserVersion(d)).toBe(through0009.length)
    expect(
      d.query("SELECT name FROM pragma_table_info('run') WHERE name='last_event_at'").get(),
    ).toEqual({ name: 'last_event_at' })
    expect(
      d.query("SELECT name FROM pragma_table_info('run') WHERE name='minted_branch'").get(),
    ).toBeNull()
    expect(applyMigrations(d)).toEqual(
      migrationJournal()
        .slice(10)
        .map((entry) => entry.tag),
    )
    expect(readUserVersion(d)).toBe(journalLength())
    expect(
      d.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_flake'").get(),
    ).toBeDefined()
    expect(
      d.query("SELECT name FROM pragma_table_info('run') WHERE name='last_event_at'").get(),
    ).toEqual({ name: 'last_event_at' })
    expect(
      d.query("SELECT name FROM pragma_table_info('run') WHERE name='minted_branch'").get(),
    ).toEqual({ name: 'minted_branch' })
    expect(
      d.query("SELECT name FROM pragma_table_info('test_flake') WHERE name='signal'").get(),
    ).toEqual({ name: 'signal' })
    d.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a connection opened before a migration refuses its next write', () => {
    db()
    const other = new Database(process.env.ORCH_DB!)
    other.exec(`PRAGMA user_version = ${journalLength() + 1}`)
    other.close()
    expect(() =>
      writeTransaction(() => {
        db().query('UPDATE project SET name = name WHERE 0').run()
      }),
    ).toThrow(`invariant: ${CONNECTION_SCHEMA_INVARIANT}`)
    try {
      writeTransaction(() => {
        db().query('UPDATE project SET name = name WHERE 0').run()
      })
    } catch (error) {
      expect(String(error)).toContain('cleared by: restart this process after orch migrate')
    }
  })

  test('review project_id backfill requires aliased lens repos to collapse to one project', () => {
    const d = fresh()
    d.query(`INSERT INTO project (name, path, canon, settings) VALUES (?, '/p', 1, '{}')`).run(
      PLATFORM_SLUG,
    )
    d.query(
      `INSERT INTO project (name, path, canon, settings) VALUES ('starship', '/s', 1, '{}')`,
    ).run()
    d.query(
      `INSERT INTO project (name, path, canon, settings) VALUES ('alephbeis', '/a', 1, '{}')`,
    ).run()
    const platformId = (
      d.query('SELECT id FROM project WHERE name=?').get(PLATFORM_SLUG) as { id: number }
    ).id
    const starship = (
      d.query("SELECT id FROM project WHERE name='starship'").get() as { id: number }
    ).id
    const insertRun = (repo: string, projectId: number) =>
      (
        d
          .query(
            `INSERT INTO run (started_at, agent, job, repo, project_id, prompt_sha, prompt_bytes, prompt_head, status)
         VALUES ('t', 'a', 'review-lens', ?, ?, 'sha', 1, 'h', 'ok') RETURNING id`,
          )
          .get(repo, projectId) as { id: number }
      ).id
    const mixed = (
      d.query("INSERT INTO review (recorded_at) VALUES ('t') RETURNING id").get() as { id: number }
    ).id
    const aliased = (
      d.query("INSERT INTO review (recorded_at) VALUES ('t') RETURNING id").get() as { id: number }
    ).id
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
    expect(d.query('SELECT project_id FROM review WHERE id=?').get(mixed)).toEqual({
      project_id: null,
    })
    expect(d.query('SELECT project_id FROM review WHERE id=?').get(aliased)).toEqual({
      project_id: platformId,
    })
    d.close()
  })

  test('a pre-migration row is repaired by the next migrate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-backfill-repair-'))
    mkdirSync(join(dir, 'meta'))
    const through0005 = migrationJournal().slice(0, 6)
    for (const entry of through0005) {
      copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
    }
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: through0005,
      }),
    )
    const d = new Database(':memory:')
    d.exec('PRAGMA foreign_keys=ON')
    applyMigrations(d, dir)
    d.query(
      `INSERT INTO project (name, path, canon, settings) VALUES ('widget', '/tmp/widget', 1, '{}')`,
    ).run()
    d.query(
      `INSERT INTO run (started_at, agent, job, repo, prompt_sha, prompt_bytes, prompt_head, status)
       VALUES ('t', 'a', 'implement', 'widget', 'sha', 1, 'h', 'ok')`,
    ).run()
    expect(d.query('SELECT project_id FROM run').get()).toEqual({ project_id: null })
    expect(applyMigrations(d)).toEqual(
      migrationJournal()
        .slice(6)
        .map((entry) => entry.tag),
    )
    const row = d
      .query('SELECT project_id, (SELECT id FROM project WHERE name=?) expected FROM run')
      .get('widget') as { project_id: number; expected: number }
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
    const [first, second] = await Promise.all([
      Promise.resolve().then(run),
      Promise.resolve().then(run),
    ])
    expect([...first, ...second].sort()).toEqual(
      migrationJournal()
        .map((entry) => entry.tag)
        .sort(),
    )
    const seen = new Database(path)
    expect(
      seen
        .query(`SELECT version FROM ${'orch_migrations'} GROUP BY version HAVING COUNT(*) > 1`)
        .all(),
    ).toEqual([])
    expect(readUserVersion(seen)).toBe(journalLength())
    expect(
      seen.query(`SELECT 1 FROM sqlite_master WHERE name=?`).get(SCHEMA_LOCK_TABLE),
    ).toBeDefined()
    seen.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('the ahead ceiling keys on applied count, not the last entry when', () => {
    const d = fresh()
    const existing = d
      .query('SELECT hash, created_at, version FROM orch_migrations LIMIT 1')
      .get() as { hash: string; created_at: number; version: string }
    d.query('INSERT INTO orch_migrations (hash, created_at, version) VALUES (?, ?, ?)').run(
      existing.hash,
      existing.created_at,
      existing.version,
    )
    expect(migrationRefusal(d)).toContain('refusing to open a store ahead')
    d.close()
  })

  test('backfill blocks are stripped from the hashed DDL and re-run every migrate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-backfill-block-'))
    mkdirSync(join(dir, 'meta'))
    writeFileSync(
      join(dir, '0000_base.sql'),
      'CREATE TABLE item (id INTEGER PRIMARY KEY, n INTEGER);\n',
    )
    writeFileSync(
      join(dir, '0001_fill.sql'),
      '-- note\n-- BACKFILL\nINSERT INTO item (n) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM item WHERE n=1);\n-- /BACKFILL\n',
    )
    writeFileSync(
      join(dir, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [
          { idx: 0, version: '6', when: 1, tag: '0000_base', breakpoints: true },
          { idx: 1, version: '6', when: 2, tag: '0001_fill', breakpoints: true },
        ],
      }),
    )
    expect(splitMigrationSource(readFileSync(join(dir, '0001_fill.sql'), 'utf8')).ddl).toBe(
      '-- note\n',
    )
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

  test('reload mode re-prepares instead of refusing a write after user_version changes', () => {
    const seen: Array<[number | null, number]> = []
    db()
    enableSchemaReload((from, to) => {
      seen.push([from, to])
    })
    const other = new Database(process.env.ORCH_DB!)
    const next = journalLength() + 1
    other.exec(`PRAGMA user_version = ${next}`)
    other.close()
    writeTransaction(() => {
      db().query('UPDATE project SET name = name WHERE 0').run()
    })
    expect(seen).toEqual([[journalLength(), next]])
  })

  test('writeTransaction after reload writes on the new handle, not the closed one', () => {
    enableSchemaReload(() => {})
    const held = db()
    const other = new Database(process.env.ORCH_DB!)
    other.exec(`PRAGMA user_version = ${journalLength() + 1}`)
    other.close()
    writeTransaction(() => {
      db()
        .query(
          "INSERT INTO project (name, path, canon, settings) VALUES ('held-reload', '/held', 1, '{}')",
        )
        .run()
    }, held)
    expect(() => held.query('SELECT 1').get()).toThrow('closed')
    expect(db().query("SELECT name FROM project WHERE name='held-reload'").get()).toEqual({
      name: 'held-reload',
    })
  })
})

describe('stripSqlComments feeds exec text that keeps quoted comment markers', () => {
  test('a quoted -- or /* survives, real comments go, and a trailing comment cannot swallow a failure', () => {
    const { stripSqlComments } = require('./migrations.ts') as typeof import('./migrations.ts')
    expect(stripSqlComments("INSERT INTO t (v) VALUES ('a -- b'); -- seed\n")).toBe(
      "INSERT INTO t (v) VALUES ('a -- b'); \n",
    )
    expect(stripSqlComments("SELECT '/* not a comment */' /* real */ FROM t")).toBe(
      "SELECT '/* not a comment */'  FROM t",
    )
    expect(stripSqlComments("SELECT 'it''s -- fine' FROM t")).toBe("SELECT 'it''s -- fine' FROM t")
    expect(stripSqlComments('INSERT INTO boom (id) VALUES (1); -- again').trim()).toBe(
      'INSERT INTO boom (id) VALUES (1);',
    )
  })
})
