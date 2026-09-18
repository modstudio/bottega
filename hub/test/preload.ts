import { Database } from 'bun:sqlite'
import { afterAll, beforeEach } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FROZEN_STATE_NAMES } from '../../shared/brand.ts'
import { createTestHubDatabaseGuard } from '../../shared/test-hub-database.ts'

const fixture = fileURLToPath(new URL('./project-register.ts', import.meta.url))
chmodSync(fixture, 0o755)
process.env.HUB_ORCH = fixture

const databaseDir = mkdtempSync(join(tmpdir(), 'hub-test-'))
process.env.HUB_DB = join(databaseDir, FROZEN_STATE_NAMES.hubDatabase)
const assertTestHubDatabase = createTestHubDatabaseGuard()
assertTestHubDatabase()
const { applyMigrations } = await import('../src/migrations.ts')
const database = new Database(process.env.HUB_DB, { create: true })
database.exec('PRAGMA foreign_keys = ON;')
applyMigrations(database)
database.close()

beforeEach(assertTestHubDatabase)

afterAll(() => rmSync(databaseDir, { recursive: true, force: true }))
