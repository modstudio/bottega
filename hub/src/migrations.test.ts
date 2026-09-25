import { Database } from 'bun:sqlite'
import { beforeAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../shared/record/schema.ts'
import { resetFixtureStore, runHubFixtureProcess } from '../test/run-fixtures.ts'
import {
  closeDatabaseForFixture,
  db,
  enableSchemaReload,
  formatMigrationRepairSummary,
  writeTransaction,
} from './db.ts'
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

const migratedThrough = (lastIndex: number, path = ':memory:') => {
  const folder = mkdtempSync(join(tmpdir(), 'hub-migration-stage-'))
  mkdirSync(join(folder, 'meta'))
  const entries = migrationJournal().slice(0, lastIndex + 1)
  for (const entry of entries)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
  )
  const database = new Database(path)
  database.exec('PRAGMA foreign_keys = ON')
  applyMigrations(database, folder)
  rmSync(folder, { recursive: true, force: true })
  return database
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

    // Remove dependents before their tables. Indexes and triggers would fall
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
      '90dedd44afbb6b3613c75611ab7e05df45476af102d38515955a4f9897f0e886',
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

  test('a matching pre-journal store adopts 0000 and reaches the current schema', () => {
    const d = baselineFresh()
    expect(applyMigrations(d)).toEqual([
      '0000_hub_baseline',
      '0001_note',
      '0002_note_acknowledgement',
      '0003_record_ledger',
      '0004_task_record_ids',
      '0005_note_record_ids',
      '0006_send_record_id',
      '0007_interval_attribution',
      '0008_task_identity',
      '0009_task_record_identity',
      '0010_question_delivery',
      '0011_operator_waiting_email',
    ])
    expect(canonicalSchemaHash(d)).toBe(expectedSchemaHash())
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
      '0006_send_record_id',
      '0007_interval_attribution',
      '0008_task_identity',
      '0009_task_record_identity',
      '0010_question_delivery',
      '0011_operator_waiting_email',
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

  test('two concurrent migrates serialize on the schema lock', async () => {
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

  test('question migration rewinds collection and the ordinary next collect fills provenance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-question-upgrade-'))
    const path = join(dir, 'hub.db')
    const fakeOrch = join(dir, 'orch')
    const askedAt = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const currentWatermark = new Date().toISOString()
    const d = migratedThrough(9, path)
    d.query(
      `INSERT INTO question
        (question_id,run_ref,root_ref,task_key,session_id,asked_at,answered_at)
       VALUES (7001,'orch:7001','orch:7001',NULL,'upgrade-session',?,NULL)`,
    ).run(askedAt)
    d.query(`INSERT INTO setting(key,value) VALUES ('collect.runs.at',?)`).run(
      JSON.stringify(currentWatermark),
    )
    expect(applyMigrations(d)).toEqual(['0010_question_delivery', '0011_operator_waiting_email'])
    const rewound = JSON.parse(
      d.query<{ value: string }, []>("SELECT value FROM setting WHERE key='collect.runs.at'").get()!
        .value,
    ) as string
    expect(rewound < askedAt).toBe(true)
    expect(applyMigrations(d)).toEqual([])
    expect(
      JSON.parse(
        d
          .query<{ value: string }, []>("SELECT value FROM setting WHERE key='collect.runs.at'")
          .get()!.value,
      ),
    ).toBe(rewound)
    d.close()

    const run = {
      id: 7001,
      started_at: askedAt,
      agent: 'fixture',
      job: 'implement',
      repo: 'fixture',
      cwd: null,
      session_id: 'upgrade-session',
      latency_ms: null,
      vendor_tokens: null,
      vendor_cost_usd: null,
      prompt_head: 'fixture',
      prompt_path: null,
      branch: null,
      probe: 1,
      status: 'asking',
      delivery: null,
      quality: null,
      questions: [
        {
          id: 7001,
          run_id: 7001,
          asked_at: askedAt,
          answered_at: new Date(Date.now() - 6 * 86_400_000).toISOString(),
          asked_via: 'reply',
          answerer_kind: 'operator',
          answer_channel: 'cli',
          deliveries: [
            {
              id: 1,
              question_id: 7001,
              run_id: 7001,
              mode: 'resume',
              outcome: 'delivered',
              at: new Date(Date.now() - 6 * 86_400_000).toISOString(),
              error: null,
            },
          ],
        },
      ],
    }
    writeFileSync(
      fakeOrch,
      `#!/usr/bin/env bun\n` +
        `if (process.argv.includes('project')) console.log('[]')\n` +
        `else { const i=process.argv.indexOf('--since'); if (process.argv[i+1] <= ${JSON.stringify(askedAt)}) console.log(${JSON.stringify(JSON.stringify(run))}) }\n`,
    )
    chmodSync(fakeOrch, 0o755)
    const collected = runHubFixtureProcess(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        `import { collectFast } from './hub/src/collect.ts'; await collectFast({ transcripts: async () => ({ rows: 0, skipped: 0 }) })`,
      ],
      {
        env: { ...process.env, HUB_DB: path, HUB_ORCH: fakeOrch },
        cwd: join(import.meta.dir, '../..'),
      },
    )
    expect(collected.exitCode, collected.stderr.toString()).toBe(0)

    const upgraded = new Database(path)
    expect(
      upgraded.query('SELECT answerer_kind FROM question WHERE question_id=7001').get(),
    ).toEqual({ answerer_kind: 'operator' })
    expect(
      upgraded.query('SELECT mode,outcome FROM question_delivery WHERE question_id=7001').all(),
    ).toEqual([{ mode: 'resume', outcome: 'delivered' }])
    upgraded.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('task identity rebuild backfills relationships and cascades record-id updates', () => {
    const d = migratedThrough(8)
    d.exec(`
      INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
      VALUES ('parent-id','DEV-1','workshop','local','2026-01-01','2026-01-01');
      INSERT INTO task(record_id,key,project,source,first_seen,last_seen,parent_key)
      VALUES ('child-id','DEV-2','workshop','local','2026-01-01','2026-01-01','DEV-1');
      INSERT INTO task_comment(task_key,body,created_at) VALUES ('DEV-2','body','2026-01-01');
      INSERT INTO task_document(task_key,title,body,version,created_at,updated_at)
      VALUES ('DEV-2','doc','body','v1','2026-01-01','2026-01-01');
      INSERT INTO task_status_event(task_key,at,to_status)
      VALUES ('DEV-2','2026-01-01','open');
      INSERT INTO task_comment(id,task_key,task_record_id,body,created_at)
      VALUES (10,'DEV-2','dangling-comment','dangling','2026-01-01');
      INSERT INTO task_document(id,task_key,task_record_id,title,body,version,created_at,updated_at)
      VALUES (20,'DEV-2','dangling-document','dangling','body','v1','2026-01-01','2026-01-01');
      INSERT INTO task_status_event(id,task_key,task_record_id,at,to_status)
      VALUES (30,'DEV-2','dangling-event','2026-01-02','active');
      UPDATE note SET project='workshop',promoted_task='DEV-2' WHERE id=(SELECT MIN(id) FROM note);
    `)
    expect(applyMigrations(d)).toEqual([
      '0009_task_record_identity',
      '0010_question_delivery',
      '0011_operator_waiting_email',
    ])
    expect(
      d
        .query(
          `SELECT table_name,row_id,task_key,old_record_id,new_record_id
         FROM task_identity_migration_repairs
         WHERE table_name IN ('task_comment','task_document','task_status_event')
         ORDER BY table_name`,
        )
        .all(),
    ).toEqual([
      {
        table_name: 'task_comment',
        row_id: '1',
        task_key: 'DEV-2',
        old_record_id: null,
        new_record_id: 'child-id',
      },
      {
        table_name: 'task_comment',
        row_id: '10',
        task_key: 'DEV-2',
        old_record_id: 'dangling-comment',
        new_record_id: 'child-id',
      },
      {
        table_name: 'task_document',
        row_id: '1',
        task_key: 'DEV-2',
        old_record_id: null,
        new_record_id: 'child-id',
      },
      {
        table_name: 'task_document',
        row_id: '20',
        task_key: 'DEV-2',
        old_record_id: 'dangling-document',
        new_record_id: 'child-id',
      },
      {
        table_name: 'task_status_event',
        row_id: '1',
        task_key: 'DEV-2',
        old_record_id: null,
        new_record_id: 'child-id',
      },
      {
        table_name: 'task_status_event',
        row_id: '30',
        task_key: 'DEV-2',
        old_record_id: 'dangling-event',
        new_record_id: 'child-id',
      },
    ])
    expect(d.query('SELECT parent_record_id FROM task WHERE key="DEV-2"').get()).toEqual({
      parent_record_id: 'parent-id',
    })
    expect(d.query('SELECT DISTINCT task_record_id FROM task_comment').all()).toEqual([
      { task_record_id: 'child-id' },
    ])
    expect(d.query('SELECT DISTINCT task_record_id FROM task_document').all()).toEqual([
      { task_record_id: 'child-id' },
    ])
    expect(d.query('SELECT DISTINCT task_record_id FROM task_status_event').all()).toEqual([
      { task_record_id: 'child-id' },
    ])
    expect(
      d.query("SELECT promoted_task_record_id FROM note WHERE promoted_task='DEV-2'").get(),
    ).toEqual({
      promoted_task_record_id: 'child-id',
    })
    expect(
      d
        .query(
          `SELECT reason,COUNT(*) count FROM task_identity_migration_repairs
           GROUP BY reason ORDER BY reason`,
        )
        .all(),
    ).toEqual([
      { reason: 'dangling task record id; attached by key', count: 3 },
      { reason: 'missing parent record id; attached by project and key', count: 1 },
      { reason: 'missing promoted task record id; attached by project and key', count: 1 },
      { reason: 'missing task record id; attached by key', count: 3 },
    ])
    d.exec("UPDATE task SET record_id='child-id-new' WHERE record_id='child-id'")
    expect(d.query('SELECT DISTINCT task_record_id FROM task_comment').all()).toEqual([
      { task_record_id: 'child-id-new' },
    ])
    expect(d.query('SELECT DISTINCT task_record_id FROM task_document').all()).toEqual([
      { task_record_id: 'child-id-new' },
    ])
    expect(d.query('SELECT DISTINCT task_record_id FROM task_status_event').all()).toEqual([
      { task_record_id: 'child-id-new' },
    ])
    d.close()
  })

  test('task identity rebuild mints ordered UUID-v7 ids and keeps its repair report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-task-id-report-'))
    const path = join(dir, 'hub.db')
    const d = migratedThrough(8, path)
    const prior = newRecordId()
    const priorTimestamp = Number.parseInt(prior.slice(0, 8) + prior.slice(9, 13), 16)
    while (Date.now() <= priorTimestamp) {}
    d.exec(`
      INSERT INTO task(key,project,source,first_seen,last_seen)
      VALUES ('MINT-1','workshop','local','2026-01-01','2026-01-01')
    `)
    const before = Date.now()
    expect(applyMigrations(d)).toEqual([
      '0009_task_record_identity',
      '0010_question_delivery',
      '0011_operator_waiting_email',
    ])
    const after = Date.now()
    const minted = d
      .query<{ record_id: string }, []>("SELECT record_id FROM task WHERE key='MINT-1'")
      .get()!.record_id
    expect(minted).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const mintedTimestamp = Number.parseInt(minted.slice(0, 8) + minted.slice(9, 13), 16)
    expect(mintedTimestamp).toBeGreaterThanOrEqual(before)
    expect(mintedTimestamp).toBeLessThanOrEqual(after)
    expect(minted > prior).toBe(true)
    d.close()

    const reopened = new Database(path)
    expect(
      reopened
        .query(
          `SELECT table_name,task_key,new_record_id,reason,projects
           FROM task_identity_migration_repairs
           WHERE reason='missing task record id; minted UUID v7'`,
        )
        .get(),
    ).toEqual({
      table_name: 'task',
      task_key: 'MINT-1',
      new_record_id: minted,
      reason: 'missing task record id; minted UUID v7',
      projects: 'workshop',
    })
    reopened.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('hub migrate formats a one-line repair summary naming the durable table', () => {
    expect(
      formatMigrationRepairSummary([
        { reason: 'missing task record id; minted UUID v7', count: 1 },
        { reason: 'dangling task record id; attached by key', count: 2 },
      ]),
    ).toBe(
      'task_identity_migration_repairs: missing task record id; minted UUID v7=1, dangling task record id; attached by key=2',
    )
    expect(formatMigrationRepairSummary([])).toBeNull()
  })

  test('task identity rebuild repairs a mixed tracker row and records shared-key uncertainty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-mixed-task-'))
    const path = join(dir, 'hub.db')
    const d = migratedThrough(8, path)
    d.exec(`
      INSERT INTO task(record_id,external_id,key,project,title,status,status_category,source,first_seen,last_seen)
      VALUES ('01a0afc8-b7b1-742a-ab2c-31e3d53c34d0','019e9824-0c10-7a73-910c-a95bd485c93d',
        'OPS-21','starship','Mixed survivor','started','active','mcp','2026-01-01','2026-01-01');
      INSERT INTO task(record_id,external_id,key,project,source,first_seen,last_seen) VALUES
        ('ambiguous-record','wrong-ambiguous','AMB-1','starship','mcp','2026-01-01','2026-01-01'),
        ('unclaimed-record','wrong-unclaimed','NONE-1','starship','mcp','2026-01-01','2026-01-01');
      INSERT INTO task_identity_claim(project,external_id,key,first_seen,last_seen) VALUES
        ('stopal','019e9824-0c10-7a73-910c-a95bd485c93d','OPS-21','2026-01-01','2026-01-01'),
        ('starship','c7dc4d23-ebee-4851-9314-69ac4d45a4ee','OPS-21','2026-01-01','2026-01-01'),
        ('starship','ambiguous-one','AMB-1','2026-01-01','2026-01-01'),
        ('starship','ambiguous-two','AMB-1','2026-01-01','2026-01-01');
      INSERT INTO task_status_event(task_key,at,to_status)
      VALUES ('OPS-21','2026-01-01','active');
    `)

    expect(applyMigrations(d)).toEqual([
      '0009_task_record_identity',
      '0010_question_delivery',
      '0011_operator_waiting_email',
    ])
    expect(
      d
        .query(
          `SELECT table_name,row_id,task_key,old_external_id,new_external_id,reason,projects
           FROM task_identity_migration_repairs
           WHERE table_name='task' OR reason='collided key; attribution uncertain'
           ORDER BY table_name,row_id,reason`,
        )
        .all(),
    ).toEqual([
      {
        table_name: 'task',
        row_id: '01a0afc8-b7b1-742a-ab2c-31e3d53c34d0',
        task_key: 'OPS-21',
        old_external_id: '019e9824-0c10-7a73-910c-a95bd485c93d',
        new_external_id: 'c7dc4d23-ebee-4851-9314-69ac4d45a4ee',
        reason: 'external id did not match identity claim; normalized by project and key',
        projects: null,
      },
      {
        table_name: 'task',
        row_id: 'ambiguous-record',
        task_key: 'AMB-1',
        old_external_id: 'wrong-ambiguous',
        new_external_id: null,
        reason: 'external id did not match identity claim; no unique project and key claim',
        projects: null,
      },
      {
        table_name: 'task',
        row_id: 'unclaimed-record',
        task_key: 'NONE-1',
        old_external_id: 'wrong-unclaimed',
        new_external_id: null,
        reason: 'external id did not match identity claim; no unique project and key claim',
        projects: null,
      },
      {
        table_name: 'task_status_event',
        row_id: '1',
        task_key: 'OPS-21',
        old_external_id: null,
        new_external_id: null,
        reason: 'collided key; attribution uncertain',
        projects: 'starship,stopal',
      },
    ])
    expect(d.query(`SELECT project,external_id FROM task WHERE key='OPS-21'`).get()).toEqual({
      project: 'starship',
      external_id: 'c7dc4d23-ebee-4851-9314-69ac4d45a4ee',
    })
    d.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('task identity rebuild refuses and names an unresolvable child', () => {
    const d = migratedThrough(8)
    d.exec('PRAGMA foreign_keys = OFF')
    d.exec(`INSERT INTO task_status_event(id,task_key,task_record_id,at,to_status) VALUES
      (1,'MISSING-42',NULL,'2026-01-01','open'),
      (2,'MISSING-43','dangling-record','2026-01-01','open')`)
    d.exec('PRAGMA foreign_keys = ON')
    expect(() => applyMigrations(d)).toThrow(
      'unresolved task_status_event rows: 1:MISSING-42, 2:MISSING-43',
    )
    expect(d.query("SELECT name FROM sqlite_master WHERE name='task_new'").get()).toBeNull()
    d.close()
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
