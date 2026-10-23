import { Database } from 'bun:sqlite'
import { afterAll, beforeEach } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FROZEN_STATE_NAMES } from '../../shared/brand.ts'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../shared/config-directory.ts'
import { machineId } from '../../shared/machine-config.ts'
import { createTestHubDatabaseGuard, mintTestHubDatabase } from '../../shared/test-hub-database.ts'
import { HUB_MIGRATION_BACKFILL_VALUES } from './migration-values.ts'

const fixture = fileURLToPath(new URL('./project-register.ts', import.meta.url))
chmodSync(fixture, 0o755)
process.env.BOTTEGA_ORCH = fixture

const { directory: databaseDir } = mintTestHubDatabase(FROZEN_STATE_NAMES.hubDatabase)
const originalConfigHome = process.env[CONFIG_HOME_ENV]
const originalHarnessEnvFile = process.env[HARNESS_ENV_FILE_ENV]
const originalRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
const configDir = mkdtempSync(join(tmpdir(), 'hub-test-config-'))
process.env[CONFIG_HOME_ENV] = configDir
machineId(HUB_MIGRATION_BACKFILL_VALUES.machine_id)
process.env[HARNESS_ENV_FILE_ENV] = ''
delete process.env.BOTTEGA_RECORD_API_URL
const assertTestHubDatabase = createTestHubDatabaseGuard()
assertTestHubDatabase()
const { applyMigrations } = await import('../src/migrations.ts')
const database = new Database(process.env.BOTTEGA_HUB_DB, { create: true })
database.exec('PRAGMA foreign_keys = ON;')
applyMigrations(database, undefined, HUB_MIGRATION_BACKFILL_VALUES)
database.close()

beforeEach(assertTestHubDatabase)

afterAll(() => {
  if (originalConfigHome === undefined) delete process.env[CONFIG_HOME_ENV]
  else process.env[CONFIG_HOME_ENV] = originalConfigHome
  if (originalHarnessEnvFile === undefined) delete process.env[HARNESS_ENV_FILE_ENV]
  else process.env[HARNESS_ENV_FILE_ENV] = originalHarnessEnvFile
  if (originalRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = originalRecordApiUrl
  rmSync(configDir, { recursive: true, force: true })
  rmSync(databaseDir, { recursive: true, force: true })
})
