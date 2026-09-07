import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyMigrations, BASELINE_SCHEMA_HASH, canonicalSchemaHash, migrationJournal,
  migrationRefusal, MIGRATIONS_FOLDER,
} from './migrations.ts'

const fresh = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys = ON')
  applyMigrations(d)
  return d
}

describe('hub migration journal', () => {
  test('fresh migrations equal trunk schema by structural hash', () => {
    const d = fresh()
    expect(canonicalSchemaHash(d)).toBe(BASELINE_SCHEMA_HASH)
    expect(BASELINE_SCHEMA_HASH).toBe('903a8d96fe8c2b5f7edd253f2f85cc6b1dc66d1537b3a94b8cef5f2fb81ddfff')
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
    const d = fresh()
    d.exec('DROP TABLE hub_migrations')
    expect(applyMigrations(d, folder)).toEqual([baseline.tag, '0001_after_adoption'])
    expect(d.query("SELECT 1 FROM sqlite_master WHERE name='adopted_followup'").get()).toBeDefined()
    d.close()
    rmSync(folder, { recursive: true, force: true })
  })
})
