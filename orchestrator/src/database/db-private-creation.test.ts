import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabasePrivately, registerOpenHooks, seedCurrentProjectSchema } from './db.ts'
import { applyMigrations } from './migrations.ts'
import { initializeDefaultLocalProject } from './project-register-store.ts'

function temporaryStore() {
  const root = mkdtempSync(join(tmpdir(), 'orch-private-create-'))
  return { root, path: join(root, 'orchestrator.db') }
}

function initialize(database: Database, root: string): void {
  applyMigrations(database)
  initializeDefaultLocalProject(database, true, false, { BOTTEGA_STATE_HOME: root })
}

test('fresh-store seeding clears its marker with and without a record session', () => {
  for (const sessionPresent of [true, false]) {
    const database = new Database(':memory:')
    applyMigrations(database)
    database.query("INSERT INTO schema_meta(key,value) VALUES ('new_store_seed_pending','1')").run()
    seedCurrentProjectSchema(database, true, sessionPresent)
    expect(database.query("SELECT name FROM project WHERE name='tasks'").all()).toHaveLength(
      sessionPresent ? 0 : 1,
    )
    expect(
      database.query("SELECT value FROM schema_meta WHERE key='new_store_seed_pending'").get(),
    ).toBeNull()
    database.close()
  }
})

test('an existing store open does not inspect the record session', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  let calls = 0
  const restore = registerOpenHooks({
    recordSessionPresent: () => {
      calls++
      return true
    },
  })
  try {
    seedCurrentProjectSchema(database, false)
    expect(calls).toBe(0)
  } finally {
    restore()
    database.close()
  }
})

test('a failed record session check does not prevent a fresh-store seed', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database.query("INSERT INTO schema_meta(key,value) VALUES ('new_store_seed_pending','1')").run()
  const restore = registerOpenHooks({
    recordSessionPresent: () => {
      throw new Error('injected session read failure')
    },
  })
  try {
    expect(() => seedCurrentProjectSchema(database, true)).not.toThrow()
    expect(database.query("SELECT name FROM project WHERE name='tasks'").all()).toEqual([
      { name: 'tasks' },
    ])
    expect(
      database.query("SELECT value FROM schema_meta WHERE key='new_store_seed_pending'").get(),
    ).toBeNull()
  } finally {
    restore()
    database.close()
  }
})

test('failed private creation leaves neither a published store nor temporary database files', () => {
  const fixture = temporaryStore()
  try {
    expect(() =>
      createDatabasePrivately(fixture.path, (database) => {
        applyMigrations(database)
        throw new Error('injected after migrations')
      }),
    ).toThrow('injected after migrations')
    expect(existsSync(fixture.path)).toBe(false)
    expect(readdirSync(fixture.root).filter((name) => name.includes('.create-'))).toEqual([])
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("a losing creator opens no replacement window and leaves the winner's default project intact", () => {
  const fixture = temporaryStore()
  try {
    const loser = createDatabasePrivately(fixture.path, (candidate) => {
      candidate.exec('CREATE TABLE losing_candidate (id INTEGER PRIMARY KEY)')
      const winner = createDatabasePrivately(fixture.path, (database) =>
        initialize(database, fixture.root),
      )
      expect(winner.published).toBe(true)
    })
    expect(loser.published).toBe(false)
    expect(readdirSync(fixture.root).filter((name) => name.includes('.create-'))).toEqual([])

    const published = new Database(fixture.path, { readonly: true })
    try {
      expect(published.query("SELECT name FROM project WHERE name = 'tasks'").all()).toEqual([
        { name: 'tasks' },
      ])
    } finally {
      published.close()
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
