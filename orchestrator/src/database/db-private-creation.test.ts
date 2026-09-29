import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabasePrivately } from './db.ts'
import { applyMigrations } from './migrations.ts'
import { initializeDefaultLocalProject } from './project-register-store.ts'

function temporaryStore() {
  const root = mkdtempSync(join(tmpdir(), 'orch-private-create-'))
  return { root, path: join(root, 'orch.db') }
}

function initialize(database: Database, root: string): void {
  applyMigrations(database)
  initializeDefaultLocalProject(database, true, { BOTTEGA_STATE_HOME: root })
}

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
      initialize(candidate, fixture.root)
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
