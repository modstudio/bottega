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
const { bootstrapFixtureStore } = await import('../src/db.ts')
bootstrapFixtureStore(process.env.HUB_DB)

beforeEach(assertTestHubDatabase)

afterAll(() => rmSync(databaseDir, { recursive: true, force: true }))
