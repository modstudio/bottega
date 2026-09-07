import { afterAll } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = new URL('./project-register.ts', import.meta.url).pathname
chmodSync(fixture, 0o755)
process.env.HUB_ORCH = fixture

const databaseDir = mkdtempSync(join(tmpdir(), 'hub-test-'))
process.env.HUB_DB = join(databaseDir, 'hub.db')
const { bootstrapFixtureStore } = await import('../src/db.ts')
bootstrapFixtureStore(process.env.HUB_DB)

afterAll(() => rmSync(databaseDir, { recursive: true, force: true }))
