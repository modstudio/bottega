import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from './migrations.ts'
import {
  DEFAULT_LOCAL_PROJECT_NAME,
  DEFAULT_LOCAL_PROJECT_SETTINGS,
  initializeDefaultLocalProject,
} from './project-register-store.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orch-default-project-'))
  const database = new Database(':memory:')
  applyMigrations(database)
  return { database, root }
}

test('a new store gets the exact default local project once', () => {
  const { database, root } = fixture()
  initializeDefaultLocalProject(database, true, { BOTTEGA_STATE_HOME: root })
  initializeDefaultLocalProject(database, true, { BOTTEGA_STATE_HOME: root })

  const rows = database
    .query('SELECT * FROM project WHERE name = ?')
    .all(DEFAULT_LOCAL_PROJECT_NAME)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    name: 'tasks',
    path: join(root, 'projects', 'tasks'),
    stack: null,
    canon: 0,
    settings: JSON.stringify(DEFAULT_LOCAL_PROJECT_SETTINGS),
  })
  expect(existsSync(join(root, 'projects', 'tasks'))).toBe(true)
})

test('an existing store is not backfilled', () => {
  const { database, root } = fixture()
  initializeDefaultLocalProject(database, false, { BOTTEGA_STATE_HOME: root })
  expect(database.query('SELECT COUNT(*) AS count FROM project').get()).toEqual({ count: 0 })
  expect(existsSync(join(root, 'projects', 'tasks'))).toBe(false)
})
