import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainCheckoutOf } from '../../shared/git.ts'
import {
  applyMigrations, BASELINE_SCHEMA_HASH, baselineSchemaHash, canonicalSchemaHash,
  CONNECTION_SCHEMA_INVARIANT, expectedSchemaHash, JOURNAL_WHEN_ORDER, journalLength,
  MIGRATIONS_FOLDER, migrationJournal, migrationRefusal, readUserVersion,
  schemaVersionLabel, splitMigrationSource,
} from './migrations.ts'
import { closeDatabaseForFixture, db, enableSchemaReload, writeTransaction } from './db.ts'

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
  for (const statement of readFileSync(join(MIGRATIONS_FOLDER, `${baseline.tag}.sql`), 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) d.exec(statement)
  }
  return d
}

const cli = new URL('./cli.ts', import.meta.url).pathname
const hub = (dbPath: string, ...args: string[]) =>
  Bun.spawnSync([process.execPath, cli, ...args], {
    env: { ...process.env, HUB_DB: dbPath }, stdout: 'pipe', stderr: 'pipe',
  })

function copyLiveHub(dest: string): void {
  const checkout = join(import.meta.dir, '../..')
  const main = mainCheckoutOf(checkout)
  expect(main, 'main checkout for live hub.db').toBeTruthy()
  const live = join(main!, 'hub', 'hub.db')
  expect(existsSync(live), live).toBe(true)
  const src = new Database(live, { readonly: true })
  try {
    src.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`)
  } finally {
    src.close()
  }
}

describe('hub migration journal', () => {
  test('fresh migrations equal trunk schema by structural hash', () => {
    const d = fresh()
    expect(canonicalSchemaHash(d)).toBe(expectedSchemaHash())
    expect(BASELINE_SCHEMA_HASH).toBe(baselineSchemaHash())
    expect(BASELINE_SCHEMA_HASH).toBe('903a8d96fe8c2b5f7edd253f2f85cc6b1dc66d1537b3a94b8cef5f2fb81ddfff')
    expect(expectedSchemaHash()).toBe('a5f77cc39d19dc1a18469a0ab9d87c1a21344bb2ddb4382618109401d28b7958')
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
    ahead.query("INSERT INTO hub_migrations (hash,created_at,version) VALUES ('future',9999999999999,'0001_future')").run()
    expect(migrationRefusal(ahead)).toContain('refusing to open a store ahead')
    expect(migrationRefusal(ahead)).toContain('cleared by: hub migrate')
    ahead.close()
  })

  test('opening a behind store refuses before an application query', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-behind-journal-'))
    const path = join(dir, 'behind.db')
    const empty = new Database(path)
    applyMigrations(empty)
    empty.exec('DELETE FROM hub_migrations')
    empty.close()
    const opened = hub(path, 'tasks')
    expect(opened.exitCode).not.toBe(0)
    expect(opened.stderr.toString()).toContain('invariant: Only hub migrate changes the store schema.')
    expect(opened.stderr.toString()).toContain('cleared by: hub migrate')
    expect(opened.stderr.toString()).not.toContain('no such table: interval')
    rmSync(dir, { recursive: true, force: true })
  })

  test('a matching pre-journal store adopts 0000 without rebuilding its schema', () => {
    const d = baselineFresh()
    const before = d.query(
      "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name",
    ).all()
    expect(applyMigrations(d)).toEqual(['0000_hub_baseline', '0001_note'])
    const after = d.query(
      "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT IN ('hub_migrations','hub_schema_lock','note','note_project_seen') ORDER BY type,name",
    ).all()
    expect(after).toEqual(before)
    d.close()
  })

  test('legacy adoption on a copy of the live hub.db, and doctor reports match', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-live-adopt-'))
    const copy = join(dir, 'hub.db')
    copyLiveHub(copy)
    // The live store is real data at real volume, which is what this test
    // wants; whether it has already been migrated is per-machine state that a
    // test must not depend on (it failed the first landing after hub migrate
    // ran on this machine). Make the copy legacy by removing the journal table.
    const probe = new Database(copy)
    probe.exec("DROP TABLE IF EXISTS note; DELETE FROM setting WHERE key='note.curator.enabled'")
    probe.exec('DROP TABLE IF EXISTS hub_migrations')
    expect(probe.query("SELECT 1 FROM sqlite_master WHERE name='hub_migrations'").get()).toBeNull()
    probe.close()
    const migrated = hub(copy, 'migrate')
    expect(migrated.exitCode, migrated.stderr.toString()).toBe(0)
    expect(migrated.stdout.toString()).toContain('applied 0000_hub_baseline')
    expect(migrated.stdout.toString()).toContain('applied 0001_note')
    const doctor = hub(copy, 'doctor')
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0)
    expect(doctor.stdout.toString()).toContain('schema hash    match')
    const d = new Database(copy)
    expect(canonicalSchemaHash(d)).toBe(expectedSchemaHash())
    d.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('live DDL drift refuses adoption with hashes, and doctor reports it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-ddl-drift-'))
    const path = join(dir, 'drift.db')
    const d = new Database(path)
    applyMigrations(d)
    d.exec('DROP TABLE hub_migrations; ALTER TABLE interval ADD COLUMN x TEXT')
    expect(canonicalSchemaHash(d)).not.toBe(BASELINE_SCHEMA_HASH)
    expect(() => applyMigrations(d)).toThrow('refusing to adopt migration baseline')
    try {
      applyMigrations(d)
    } catch (error) {
      const message = String(error)
      expect(message).toContain(`stored hash: ${canonicalSchemaHash(d)}`)
      expect(message).toContain(`expected hash: ${BASELINE_SCHEMA_HASH}`)
      expect(message).toContain('unexpected columns: interval.x text notnull=0 default=NULL pk=0')
      expect(message).toContain("back up the store and run the old binary's open once")
    }
    d.close()
    const doctorPath = join(dir, 'doctor-drift.db')
    const doctorStore = new Database(doctorPath)
    applyMigrations(doctorStore)
    doctorStore.exec('ALTER TABLE interval ADD COLUMN x TEXT')
    doctorStore.close()
    const doctor = hub(doctorPath, 'doctor')
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0)
    expect(doctor.stdout.toString()).toContain('schema hash    DRIFT')
    rmSync(dir, { recursive: true, force: true })
  })

  test('legacy adoption continues through a future hand-written migration', () => {
    const folder = mkdtempSync(join(tmpdir(), 'hub-adopt-'))
    mkdirSync(join(folder, 'meta'))
    const baseline = migrationJournal()[0]!
    copyFileSync(join(MIGRATIONS_FOLDER, `${baseline.tag}.sql`), join(folder, `${baseline.tag}.sql`))
    writeFileSync(join(folder, '0001_after_adoption.sql'),
      'CREATE TABLE adopted_followup (id INTEGER PRIMARY KEY);\n')
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({
      version: '7', dialect: 'sqlite', entries: [
        { ...baseline, version: '6', breakpoints: true },
        { idx: 1, version: '6', when: baseline.when + 1,
          tag: '0001_after_adoption', breakpoints: true },
      ],
    }))
    const d = baselineFresh()
    expect(applyMigrations(d, folder)).toEqual([baseline.tag, '0001_after_adoption'])
    expect(d.query("SELECT 1 FROM sqlite_master WHERE name='adopted_followup'").get()).toBeDefined()
    d.close()
    rmSync(folder, { recursive: true, force: true })
  })

  test('a stray trigger refuses adoption and doctor reports DRIFT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-stray-trigger-'))
    const path = join(dir, 'adopt.db')
    const d = new Database(path)
    applyMigrations(d)
    d.exec(`CREATE TRIGGER setting_shadow AFTER INSERT ON setting BEGIN SELECT 1; END`)
    d.exec('DROP TABLE hub_migrations')
    expect(() => applyMigrations(d)).toThrow('refusing to adopt migration baseline')
    try {
      applyMigrations(d)
    } catch (error) {
      const message = String(error)
      expect(message).toContain('unexpected triggers:')
      expect(message).toContain('setting_shadow')
      expect(message).not.toContain('unexpected triggers: none')
    }
    d.close()
    const doctorPath = join(dir, 'doctor.db')
    const doctorStore = new Database(doctorPath)
    applyMigrations(doctorStore)
    doctorStore.exec(`CREATE TRIGGER setting_shadow AFTER INSERT ON setting BEGIN SELECT 1; END`)
    doctorStore.close()
    const doctor = hub(doctorPath, 'doctor')
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0)
    expect(doctor.stdout.toString()).toContain('schema hash    DRIFT')
    rmSync(dir, { recursive: true, force: true })
  })

  test('a stray view refuses adoption and doctor reports DRIFT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-stray-view-'))
    const path = join(dir, 'adopt.db')
    const d = new Database(path)
    applyMigrations(d)
    d.exec(`CREATE VIEW setting_names AS SELECT key FROM setting`)
    d.exec('DROP TABLE hub_migrations')
    expect(() => applyMigrations(d)).toThrow('refusing to adopt migration baseline')
    try {
      applyMigrations(d)
    } catch (error) {
      const message = String(error)
      expect(message).toContain('unexpected views:')
      expect(message).toContain('setting_names')
      expect(message).not.toContain('unexpected views: none')
    }
    d.close()
    const doctorPath = join(dir, 'doctor.db')
    const doctorStore = new Database(doctorPath)
    applyMigrations(doctorStore)
    doctorStore.exec(`CREATE VIEW setting_names AS SELECT key FROM setting`)
    doctorStore.close()
    const doctor = hub(doctorPath, 'doctor')
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0)
    expect(doctor.stdout.toString()).toContain('schema hash    DRIFT')
    rmSync(dir, { recursive: true, force: true })
  })

  test('doctor matches the full journal, a stray column drifts, and legacy adoption still matches entry 0', () => {
    const folder = mkdtempSync(join(tmpdir(), 'hub-expected-hash-'))
    mkdirSync(join(folder, 'meta'))
    const baseline = migrationJournal()[0]!
    copyFileSync(join(MIGRATIONS_FOLDER, `${baseline.tag}.sql`), join(folder, `${baseline.tag}.sql`))
    writeFileSync(join(folder, '0001_extra.sql'), 'CREATE TABLE extra (id INTEGER PRIMARY KEY);\n')
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({
      version: '7', dialect: 'sqlite', entries: [
        { ...baseline, version: '6', breakpoints: true },
        { idx: 1, version: '6', when: baseline.when + 1, tag: '0001_extra', breakpoints: true },
      ],
    }))
    const d = new Database(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    applyMigrations(d, folder)
    expect(canonicalSchemaHash(d)).toBe(expectedSchemaHash(folder))
    expect(canonicalSchemaHash(d)).not.toBe(BASELINE_SCHEMA_HASH)
    d.exec('ALTER TABLE extra ADD COLUMN x TEXT')
    expect(canonicalSchemaHash(d)).not.toBe(expectedSchemaHash(folder))
    d.close()

    const legacy = baselineFresh()
    expect(applyMigrations(legacy)).toEqual(['0000_hub_baseline', '0001_note'])
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

  test('a journal whose entries are idx-ordered but when-unordered is refused at load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-when-unordered-'))
    mkdirSync(join(dir, 'meta'))
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({
      version: '7', dialect: 'sqlite', entries: [
        { idx: 0, version: '6', when: 100, tag: '0000_first', breakpoints: true },
        { idx: 1, version: '6', when: 300, tag: '0001_later', breakpoints: true },
        { idx: 2, version: '6', when: 200, tag: '0002_earlier', breakpoints: true },
      ],
    }))
    expect(() => migrationJournal(dir)).toThrow(`invariant: ${JOURNAL_WHEN_ORDER}`)
    rmSync(dir, { recursive: true, force: true })
  })

  test('the migrator stamps user_version to the journal length even when nothing is pending', () => {
    const d = fresh()
    expect(readUserVersion(d)).toBe(journalLength())
    expect(schemaVersionLabel(d)).toBe(String(journalLength()))
    expect(applyMigrations(d)).toEqual([])
    expect(readUserVersion(d)).toBe(journalLength())
    d.close()
  })

  test('doctor reports unstamped for user_version 0 rather than behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-unstamped-'))
    const path = join(dir, 'store.db')
    const d = new Database(path)
    applyMigrations(d)
    d.exec('PRAGMA user_version = 0')
    expect(schemaVersionLabel(d)).toBe('unstamped')
    d.close()
    const doctor = hub(path, 'doctor')
    expect(doctor.exitCode, doctor.stderr.toString()).toBe(0)
    expect(doctor.stdout.toString()).toMatch(/^schema version unstamped$/m)
    rmSync(dir, { recursive: true, force: true })
  })

  test('a connection opened before a migration refuses its next write', () => {
    closeDatabaseForFixture()
    db()
    const other = new Database(process.env.HUB_DB!)
    other.exec(`PRAGMA user_version = ${journalLength() + 1}`)
    other.close()
    expect(() => writeTransaction(() => {
      db().query('UPDATE setting SET value = value WHERE 0').run()
    })).toThrow(`invariant: ${CONNECTION_SCHEMA_INVARIANT}`)
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
    const [first, second] = await Promise.all([Promise.resolve().then(run), Promise.resolve().then(run)])
    expect([...first, ...second].sort()).toEqual(migrationJournal().map((entry) => entry.tag).sort())
    const seen = new Database(path)
    expect(seen.query(
      'SELECT version FROM hub_migrations GROUP BY version HAVING COUNT(*) > 1',
    ).all()).toEqual([])
    expect(readUserVersion(seen)).toBe(journalLength())
    seen.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('the ahead ceiling keys on applied count, not the last entry when', () => {
    const d = fresh()
    const existing = d.query(
      'SELECT hash, created_at, version FROM hub_migrations LIMIT 1',
    ).get() as { hash: string; created_at: number; version: string }
    d.query('INSERT INTO hub_migrations (hash, created_at, version) VALUES (?, ?, ?)').run(
      existing.hash, existing.created_at, existing.version,
    )
    expect(migrationRefusal(d)).toContain('refusing to open a store ahead')
    d.close()
  })

  test('backfill blocks are stripped from the hashed DDL and re-run every migrate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-backfill-block-'))
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
    d.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('reload mode reloads the query layer after user_version changes', () => {
    closeDatabaseForFixture()
    const seen: number[] = []
    db()
    enableSchemaReload((_from, to) => { seen.push(to) })
    const other = new Database(process.env.HUB_DB!)
    const next = journalLength() + 1
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
    other.exec(`PRAGMA user_version = ${journalLength() + 1}`)
    other.close()
    writeTransaction(() => {
      db().query("INSERT INTO setting (key, value) VALUES ('held-reload', '1')").run()
    }, held)
    expect(() => held.query('SELECT 1').get()).toThrow('closed')
    expect(db().query("SELECT value FROM setting WHERE key='held-reload'").get()).toEqual({ value: '1' })
    closeDatabaseForFixture()
    const reset = new Database(process.env.HUB_DB!)
    applyMigrations(reset)
    reset.close()
  })
})
