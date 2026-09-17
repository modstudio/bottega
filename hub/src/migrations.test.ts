import { Database } from 'bun:sqlite'
import { beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { closeDatabaseForFixture, db, enableSchemaReload, writeTransaction } from './db.ts'
import {
  applyMigrations,
  CONNECTION_SCHEMA_INVARIANT,
  canonicalSchemaHash,
  expectedSchemaHash,
  JOURNAL_WHEN_ORDER,
  MIGRATIONS_FOLDER,
  MIGRATIONS_TABLE,
  migrationJournal,
  migrationRefusal,
  readUserVersion,
  SCHEMA_LOCK_TABLE,
  schemaVersionLabel,
  splitMigrationSource,
  stripSqlComments,
} from './migrations.ts'

beforeAll(resetFixtureStore)

const fresh = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys = ON')
  applyMigrations(d)
  return d
}

const baselineFresh = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys = ON')
  const baseline = migrationJournal()[0]!
  for (const statement of readFileSync(
    join(MIGRATIONS_FOLDER, `${baseline.tag}.sql`),
    'utf8',
  ).split('--> statement-breakpoint')) {
    if (statement.trim()) d.exec(statement)
  }
  return d
}

type ApplicationObject = {
  type: 'table' | 'index' | 'view' | 'trigger'
  name: string
  tbl_name: string
}

const applicationObjects = (d: Database): ApplicationObject[] =>
  d
    .query<ApplicationObject, [string, string]>(
      `SELECT type,name,tbl_name FROM sqlite_master
    WHERE type IN ('table','index','view','trigger')
      AND name NOT LIKE 'sqlite_%' AND name NOT IN (?, ?)
    ORDER BY type,name`,
    )
    .all(MIGRATIONS_TABLE, SCHEMA_LOCK_TABLE)

type SchemaRow = { type: string; name: string; sql: string }
const applicationSchemaRows = (d: Database) =>
  d
    .query<SchemaRow, [string, string]>(
      `SELECT type,name,sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT IN (?, ?)
    ORDER BY type,name`,
    )
    .all(MIGRATIONS_TABLE, SCHEMA_LOCK_TABLE)

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`

/** Reduce any later journal state to the baseline application-object inventory. */
function stripPostBaselineApplicationObjects(d: Database): void {
  const foreignKeys =
    d.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys ?? 0
  // baselineFresh enables enforcement while a live copy uses Bun's default of
  // OFF; normalize the strip itself so both probe paths exercise one behavior.
  d.exec('PRAGMA foreign_keys = OFF')
  try {
    const baseline = baselineFresh()
    const baselineNames = new Set(
      applicationObjects(baseline).map((row) => `${row.type}:${row.name}`),
    )
    baseline.close()
    const extras = applicationObjects(d).filter(
      (row) => !baselineNames.has(`${row.type}:${row.name}`),
    )

    // Remove dependants before their tables. Indexes and triggers would fall
    // with a table, but dropping them explicitly also handles additions to a
    // baseline table. Views go first because they may read a later table.
    for (const type of ['trigger', 'view', 'index'] as const) {
      for (const row of extras.filter((candidate) => candidate.type === type)) {
        d.exec(`DROP ${type.toUpperCase()} ${quoteIdentifier(row.name)}`)
      }
    }

    const tables = new Set(extras.filter((row) => row.type === 'table').map((row) => row.name))
    const children = new Map<string, string[]>()
    for (const child of tables) {
      const references = d
        .query<{ table: string }, []>(`PRAGMA foreign_key_list(${quoteIdentifier(child)})`)
        .all()
      for (const reference of references) {
        if (!tables.has(reference.table)) continue
        const list = children.get(reference.table) ?? []
        list.push(child)
        children.set(reference.table, list)
      }
    }
    const dropped = new Set<string>()
    const visiting = new Set<string>()
    const dropChildFirst = (table: string): void => {
      if (dropped.has(table) || visiting.has(table)) return
      visiting.add(table)
      for (const child of children.get(table) ?? []) dropChildFirst(child)
      visiting.delete(table)
      d.exec(`DROP TABLE ${quoteIdentifier(table)}`)
      dropped.add(table)
    }
    for (const table of tables) dropChildFirst(table)
  } finally {
    d.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
  }
}

describe('hub migration journal', () => {
  test('fresh migrations equal trunk schema by structural hash', () => {
    const d = fresh()
    expect(canonicalSchemaHash(d)).toBe(expectedSchemaHash())
    expect(expectedSchemaHash()).toBe(
      '39333f6764f05df23f44a906308df129ba8f0dc2d6737170cd663cd0e6bc4142',
    )
    d.close()
  })

  test('behind and ahead stores refuse with both lifecycle anchors', () => {
    const d = fresh()
    d.exec('DELETE FROM hub_migrations')
    expect(migrationRefusal(d)).toContain('refusing to open a store behind')
    expect(migrationRefusal(d)).toContain('invariant: Only hub migrate changes the store schema.')
    expect(migrationRefusal(d)).toContain('cleared by: hub migrate')
    d.close()

    const ahead = fresh()
    ahead
      .query(
        "INSERT INTO hub_migrations (hash,created_at,version) VALUES ('future',9999999999999,'0001_future')",
      )
      .run()
    expect(migrationRefusal(ahead)).toContain('refusing to open a store ahead')
    expect(migrationRefusal(ahead)).toContain('cleared by: hub migrate')
    ahead.close()
  })

  test('a matching pre-journal store adopts 0000 without rebuilding its schema', () => {
    const d = baselineFresh()
    const before = applicationSchemaRows(d)
    expect(applyMigrations(d)).toEqual([
      '0000_hub_baseline',
      '0001_note',
      '0002_note_acknowledgement',
      '0003_record_ledger',
      '0004_task_record_ids',
      '0005_note_record_ids',
    ])
    stripPostBaselineApplicationObjects(d)
    const after = applicationSchemaRows(d)
    expect(
      after.map((row) => ({
        ...row,
        sql: row.sql?.replace(/, record_id TEXT\)/g, ')'),
      })),
    ).toEqual(before)
    d.close()
  })

  test('the adoption strip handles populated foreign-key cycles and restores enforcement', () => {
    const expected = baselineFresh()
    const baselineSchema = applicationSchemaRows(expected)
    expected.close()

    const d = baselineFresh()
    d.exec('PRAGMA foreign_keys = OFF')
    d.exec(`
      CREATE TABLE later_a (
        id INTEGER PRIMARY KEY,
        later_b_id INTEGER NOT NULL REFERENCES later_b(id)
      );
      CREATE TABLE later_b (
        id INTEGER PRIMARY KEY,
        later_a_id INTEGER NOT NULL REFERENCES later_a(id)
      );
      INSERT INTO later_a (id,later_b_id) VALUES (1,1);
      INSERT INTO later_b (id,later_a_id) VALUES (1,1);
    `)
    d.exec('PRAGMA foreign_keys = ON')

    stripPostBaselineApplicationObjects(d)

    expect(applicationSchemaRows(d)).toEqual(baselineSchema)
    expect(d.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1)
    d.close()
  })

  test('legacy adoption continues through a future hand-written migration', () => {
    const folder = mkdtempSync(join(tmpdir(), 'hub-adopt-'))
    mkdirSync(join(folder, 'meta'))
    const baseline = migrationJournal()[0]!
    copyFileSync(
      join(MIGRATIONS_FOLDER, `${baseline.tag}.sql`),
      join(folder, `${baseline.tag}.sql`),
    )
    writeFileSync(
      join(folder, '0001_after_adoption.sql'),
      'CREATE TABLE adopted_followup (id INTEGER PRIMARY KEY);\n',
    )
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
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
    const d = baselineFresh()
    expect(applyMigrations(d, folder)).toEqual([baseline.tag, '0001_after_adoption'])
    expect(d.query("SELECT 1 FROM sqlite_master WHERE name='adopted_followup'").get()).toBeDefined()
    d.close()
    rmSync(folder, { recursive: true, force: true })
  })

  test('doctor matches the full journal, a stray column drifts, and legacy adoption still matches entry 0', () => {
    const folder = mkdtempSync(join(tmpdir(), 'hub-expected-hash-'))
    mkdirSync(join(folder, 'meta'))
    const baseline = migrationJournal()[0]!
    copyFileSync(
      join(MIGRATIONS_FOLDER, `${baseline.tag}.sql`),
      join(folder, `${baseline.tag}.sql`),
    )
    writeFileSync(join(folder, '0001_extra.sql'), 'CREATE TABLE extra (id INTEGER PRIMARY KEY);\n')
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [
          { ...baseline, version: '6', breakpoints: true },
          { idx: 1, version: '6', when: baseline.when + 1, tag: '0001_extra', breakpoints: true },
        ],
      }),
    )
    const d = new Database(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    applyMigrations(d, folder)
    expect(canonicalSchemaHash(d)).toBe(expectedSchemaHash(folder))
    d.exec('ALTER TABLE extra ADD COLUMN x TEXT')
    expect(canonicalSchemaHash(d)).not.toBe(expectedSchemaHash(folder))
    d.close()

    const legacy = baselineFresh()
    expect(applyMigrations(legacy)).toEqual([
      '0000_hub_baseline',
      '0001_note',
      '0002_note_acknowledgement',
      '0003_record_ledger',
      '0004_task_record_ids',
      '0005_note_record_ids',
    ])
    expect(canonicalSchemaHash(legacy)).toBe(expectedSchemaHash())
    legacy.close()
    rmSync(folder, { recursive: true, force: true })
  })

  test('adoption names a rebuilt CHECK that the hash already includes', () => {
    const d = baselineFresh()
    d.exec(`DROP TABLE seq;
      CREATE TABLE seq (
        name TEXT PRIMARY KEY,
        next INTEGER NOT NULL,
        CHECK (next > 0)
      )`)
    expect(() => applyMigrations(d)).toThrow('refusing to adopt migration baseline')
    try {
      applyMigrations(d)
    } catch (error) {
      const message = String(error)
      expect(message).toContain('unexpected checks: check seq next>0')
      expect(message).toContain('missing checks: none')
    }
    d.close()
  })

  test('adoption names a rebuilt foreign key that the hash already includes', () => {
    const missing =
      'foreign-key {"table":"task_comment","id":0,"sequence":0,"targetTable":"task","from":"task_key","to":"key","onUpdate":"no action","onDelete":"cascade","match":"none"}'
    const unexpected =
      'foreign-key {"table":"task_comment","id":0,"sequence":0,"targetTable":"task","from":"task_key","to":"key","onUpdate":"no action","onDelete":"set null","match":"none"}'
    const d = baselineFresh()
    d.exec(`DROP TABLE task_comment;
      CREATE TABLE task_comment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_key TEXT NOT NULL REFERENCES task(key) ON DELETE SET NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX task_comment_task ON task_comment(task_key, created_at);`)
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
    const dir = mkdtempSync(join(tmpdir(), 'hub-pk-collide-'))
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

  test('a journal whose entries are idx-ordered but when-unordered is refused at load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-when-unordered-'))
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
    expect(() => migrationJournal(dir)).toThrow(`invariant: ${JOURNAL_WHEN_ORDER}`)
    rmSync(dir, { recursive: true, force: true })
  })

  test('the migrator stamps user_version to the journal length even when nothing is pending', () => {
    const d = fresh()
    expect(readUserVersion(d)).toBe(migrationJournal().length)
    expect(schemaVersionLabel(d)).toBe(String(migrationJournal().length))
    expect(applyMigrations(d)).toEqual([])
    expect(readUserVersion(d)).toBe(migrationJournal().length)
    d.close()
  })

  test('a connection opened before a migration refuses its next write', () => {
    closeDatabaseForFixture()
    db()
    const other = new Database(process.env.HUB_DB!)
    other.exec(`PRAGMA user_version = ${migrationJournal().length + 1}`)
    other.close()
    expect(() =>
      writeTransaction((conn) => {
        conn.query('UPDATE setting SET value = value WHERE 0').run()
      }),
    ).toThrow(`invariant: ${CONNECTION_SCHEMA_INVARIANT}`)
    closeDatabaseForFixture()
    const reset = new Database(process.env.HUB_DB!)
    applyMigrations(reset)
    reset.close()
  })

  test('two concurrent migrates serialise on the schema lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-concurrent-migrate-'))
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
      seen.query('SELECT version FROM hub_migrations GROUP BY version HAVING COUNT(*) > 1').all(),
    ).toEqual([])
    expect(readUserVersion(seen)).toBe(migrationJournal().length)
    seen.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('the ahead ceiling keys on applied count, not the last entry when', () => {
    const d = fresh()
    const existing = d
      .query('SELECT hash, created_at, version FROM hub_migrations LIMIT 1')
      .get() as { hash: string; created_at: number; version: string }
    d.query('INSERT INTO hub_migrations (hash, created_at, version) VALUES (?, ?, ?)').run(
      existing.hash,
      existing.created_at,
      existing.version,
    )
    expect(migrationRefusal(d)).toContain('refusing to open a store ahead')
    d.close()
  })

  test('backfill blocks are stripped from the hashed DDL and re-run every migrate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-backfill-block-'))
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
    d.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('reload mode reloads the query layer after user_version changes', () => {
    closeDatabaseForFixture()
    const seen: number[] = []
    db()
    enableSchemaReload((_from, to) => {
      seen.push(to)
    })
    const other = new Database(process.env.HUB_DB!)
    const next = migrationJournal().length + 1
    other.exec(`PRAGMA user_version = ${next}`)
    other.close()
    db()
    expect(seen).toEqual([next])
    closeDatabaseForFixture()
    const reset = new Database(process.env.HUB_DB!)
    applyMigrations(reset)
    reset.close()
  })

  test('writeTransaction after reload writes on the new handle, not the closed one', () => {
    closeDatabaseForFixture()
    enableSchemaReload(() => {})
    const held = db()
    const other = new Database(process.env.HUB_DB!)
    other.exec(`PRAGMA user_version = ${migrationJournal().length + 1}`)
    other.close()
    writeTransaction((conn) => {
      conn.query("INSERT INTO setting (key, value) VALUES ('held-reload', '1')").run()
    }, held)
    expect(() => held.query('SELECT 1').get()).toThrow('closed')
    expect(db().query("SELECT value FROM setting WHERE key='held-reload'").get()).toEqual({
      value: '1',
    })
    closeDatabaseForFixture()
    const reset = new Database(process.env.HUB_DB!)
    applyMigrations(reset)
    reset.close()
  })

  test('the shared handle refuses a write outside writeTransaction', () => {
    expect(() =>
      db().query("INSERT INTO setting (key, value) VALUES ('unchecked-write', '1')").run(),
    ).toThrow('attempt to write a readonly database')
    expect(db().query("SELECT value FROM setting WHERE key = 'unchecked-write'").get()).toBeNull()
  })

  test('a nested writeTransaction leaves the outer connection writable', () => {
    writeTransaction((outer) => {
      outer.query("INSERT INTO setting (key, value) VALUES ('nested-outer-before', '1')").run()
      writeTransaction((inner) => {
        inner.query("INSERT INTO setting (key, value) VALUES ('nested-inner', '1')").run()
      })
      outer.query("INSERT INTO setting (key, value) VALUES ('nested-outer-after', '1')").run()
    })
    expect(
      db()
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM setting WHERE key LIKE 'nested-%'",
        )
        .get(),
    ).toEqual({ count: 3 })
  })
})

describe('stripSqlComments keeps quoted comment markers', () => {
  test('quoted -- and /* survive while real comments are removed', () => {
    expect(stripSqlComments("INSERT INTO t (v) VALUES ('a -- b'); -- seed\n")).toBe(
      "INSERT INTO t (v) VALUES ('a -- b'); \n",
    )
    expect(stripSqlComments("SELECT '/* x */' /* real */ FROM t")).toBe("SELECT '/* x */'  FROM t")
  })
})
