import { Database } from 'bun:sqlite'
import { afterAll, beforeEach } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestHubDatabaseGuard } from '../../shared/test-hub-database.ts'

const fixture = new URL('./project-register.ts', import.meta.url).pathname
chmodSync(fixture, 0o755)
process.env.HUB_ORCH = fixture

const databaseDir = mkdtempSync(join(tmpdir(), 'hub-test-'))
process.env.HUB_DB = join(databaseDir, 'hub.db')
const assertTestHubDatabase = createTestHubDatabaseGuard(new URL('../..', import.meta.url).pathname)
assertTestHubDatabase()
const { applyMigrations } = await import('../src/migrations.ts')
const database = new Database(process.env.HUB_DB, { create: true })
database.exec('PRAGMA foreign_keys = ON;')
applyMigrations(database)
database.close()

beforeEach(assertTestHubDatabase)

afterAll(() => rmSync(databaseDir, { recursive: true, force: true }))
