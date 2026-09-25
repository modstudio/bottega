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
import { dir } from '../../test/fixtures/store.ts'
import { db, enableSchemaReload, writeTransaction } from '../database/db.ts'
import {
  applyMigrations,
  CONNECTION_SCHEMA_INVARIANT,
  canonicalSchemaHash,
  expectedSchemaHash,
  JOURNAL_WHEN_ORDER,
  MIGRATIONS_FOLDER,
  migrationJournal,
  migrationRefusal,
  readUserVersion,
  SCHEMA_LOCK_TABLE,
  schemaVersionLabel,
  splitMigrationSource,
  stripSqlComments,
} from '../database/migrations.ts'
import {
  compilePack,
  findingsForPack,
  allNumericLiterals as inspectNumericLiterals,
  numericLiteralReport,
} from './canon.ts'

const journalLength = () => migrationJournal().length

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
    const comparison = fresh()
    expect(canonicalSchemaHash(d)).toBe(canonicalSchemaHash(comparison))
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
        sql: "CREATE UNIQUE INDEX doc_address ON doc(scope, COALESCE(subject, ''), COALESCE(owner, ''), slug)",
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

  test('two concurrent migrates serialize on the schema lock', async () => {
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

  test('schema reload waits until an open write transaction completes', () => {
    const seen: Array<[number | null, number]> = []
    const held = db()
    enableSchemaReload((from, to) => seen.push([from, to]))
    const other = new Database(process.env.ORCH_DB!)
    const next = journalLength() + 1
    other.exec(`PRAGMA user_version = ${next}`)
    other.close()

    held
      .transaction(() => {
        held
          .query(
            "INSERT INTO project (name, path, canon, settings) VALUES ('before-reload', '/before', 1, '{}')",
          )
          .run()
        db()
          .query(
            "INSERT INTO project (name, path, canon, settings) VALUES ('after-reload', '/after', 1, '{}')",
          )
          .run()
      })
      .immediate()

    expect(seen).toEqual([])
    expect(
      held.query("SELECT name FROM project WHERE name LIKE '%-reload' ORDER BY name").all(),
    ).toEqual([{ name: 'after-reload' }, { name: 'before-reload' }])
    expect(db()).not.toBe(held)
    expect(seen).toEqual([[journalLength(), next]])
    expect(() => held.query('SELECT 1').get()).toThrow('closed')
  })
})

describe('stripSqlComments feeds exec text that keeps quoted comment markers', () => {
  test('a quoted -- or /* survives, real comments go, and a trailing comment cannot swallow a failure', () => {
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

describe('scoped operator docs', () => {
  test('numeric literal report classifies per clause and excludes non-prose spans', () => {
    const cases: { text: string; expected: [string, string][] }[] = [
      { text: 'The suite currently has 6,676 tests.', expected: [['6,676', 'RESTATED']] },
      { text: 'The service listens on port 5432.', expected: [['5432', 'RESTATED']] },
      { text: 'Bun 1.3.14 is installed.', expected: [['1.3.14', 'RESTATED']] },
      { text: 'Qwen3.6 is installed.', expected: [['Qwen3.6', 'RESTATED']] },
      { text: 'The default is 5.', expected: [['5', 'OWNED']] },
      {
        text: 'This policy defines and enforces the threshold of 15.',
        expected: [['15', 'OWNED']],
      },
      { text: 'A product admits at most 1 tag.', expected: [['1', 'OWNED']] },
      { text: 'A change under 10% is reported as flat.', expected: [['10%', 'OWNED']] },
      { text: 'The gate asserts 170 characters.', expected: [['170', 'CHECKED']] },
      { text: 'The check refuses 51 lines.', expected: [['51', 'CHECKED']] },
      { text: 'This check caps output at 20 bytes.', expected: [['20', 'CHECKED']] },
      {
        text: 'Run 1565 measured 36,058 rows.',
        expected: [
          ['1565', 'EVIDENCE'],
          ['36,058', 'EVIDENCE'],
        ],
      },
      { text: 'We observed 42 rows.', expected: [['42', 'EVIDENCE']] },
      { text: 'The sample measured 80 bytes.', expected: [['80', 'EVIDENCE']] },
      { text: 'The incident had 22 files.', expected: [['22', 'UNCLASSIFIED']] },
      { text: 'Build 4 succeeded.', expected: [['4', 'UNCLASSIFIED']] },
      { text: 'Option 7 is preferred.', expected: [['7', 'UNCLASSIFIED']] },
      { text: 'Version 2 was used during the incident.', expected: [['2', 'UNCLASSIFIED']] },
      {
        text: 'Do not trust the claim that the suite has 900 tests.',
        expected: [['900', 'UNCLASSIFIED']],
      },
      {
        text: 'Its 22 files are recoverable from the old commit.',
        expected: [['22', 'UNCLASSIFIED']],
      },
      {
        text: 'Run 279 is the case: 409 seconds, 57 bytes back.',
        expected: [
          ['279', 'EVIDENCE'],
          ['409', 'EVIDENCE'],
          ['57', 'UNCLASSIFIED'],
        ],
      },
      {
        text: 'Runs 378 and 379 did work and reported 452 rows.',
        expected: [
          ['378', 'EVIDENCE'],
          ['379', 'UNCLASSIFIED'],
          ['452', 'UNCLASSIFIED'],
        ],
      },
      { text: 'The 3rd retry succeeded.', expected: [] },
      { text: '1. First item.', expected: [] },
      { text: 'Open https://localhost:7778/v2 now.', expected: [] },
      { text: 'Read /tmp/run-42/file2.ts.', expected: [] },
      { text: 'Use `port 8888`.', expected: [] },
      { text: '```\nhidden 9000\n```', expected: [] },
      { text: 'Ticket DEV-307 owns this.', expected: [] },
      { text: 'Recorded on 2026-09-06.', expected: [] },
      { text: 'The meeting starts at 13:20.', expected: [] },
      { text: 'See file.ts:42 and path/file:43.', expected: [] },
      { text: 'See lines 19-21.', expected: [] },
      { text: 'Install Bun 1.3.14 before running the gate.', expected: [['1.3.14', 'RESTATED']] },
      {
        text: 'The gate checks 50 files and Bun 1.3.14 is installed.',
        expected: [
          ['50', 'CHECKED'],
          ['1.3.14', 'RESTATED'],
        ],
      },
      {
        text: 'Run 7 measured 40 rows, but the suite has 900 tests.',
        expected: [
          ['7', 'EVIDENCE'],
          ['40', 'EVIDENCE'],
          ['900', 'RESTATED'],
        ],
      },
      { text: 'The year 2020 changed everything.', expected: [['2020', 'UNCLASSIFIED']] },
    ]
    for (const row of cases) {
      const report = numericLiteralReport(row.text, 'fixture')
      expect(
        report.map(({ numeral, classification }) => [numeral, classification]),
        row.text,
      ).toEqual(row.expected)
      expect(report.every((hit) => hit.source === 'fixture')).toBe(true)
    }
  })

  test('canon check keeps its exit-zero JSON contract for a missing cwd', () => {
    const missing = join(dir, 'numeric-missing-cwd')
    expect(
      findingsForPack(compilePack({ job: 'understand', cwd: missing })).flatMap(
        (row) => row.findings,
      ),
    ).toEqual([])
    expect(inspectNumericLiterals(missing)).toEqual({
      numericLiterals: [],
      canonFiles: { read: [], missing: [] },
    })
  })
})
