import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainCheckoutOf } from '../../shared/git.ts'
import {
  applyMigrations, BASELINE_SCHEMA_HASH, baselineSchemaHash, canonicalSchemaHash,
  expectedSchemaHash, migrationJournal, migrationRefusal, MIGRATIONS_FOLDER,
} from './migrations.ts'

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
      "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT IN ('hub_migrations','note','note_project_seen') ORDER BY type,name",
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
})
