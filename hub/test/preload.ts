import { Database } from 'bun:sqlite'
import { afterAll, beforeEach } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FROZEN_STATE_NAMES } from '../../shared/brand.ts'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../shared/config-directory.ts'
import { machineId } from '../../shared/machine-config.ts'
import { STATE_HOME_ENV } from '../../shared/state-directory.ts'
import { createTestHubDatabaseGuard, mintTestHubDatabase } from '../../shared/test-hub-database.ts'
import { HUB_MIGRATION_BACKFILL_VALUES } from './migration-values.ts'

const fixture = fileURLToPath(new URL('./project-register.ts', import.meta.url))
if ((statSync(fixture).mode & 0o100) === 0) {
  try {
    chmodSync(fixture, 0o755)
  } catch (cause) {
    throw new Error(
      `Could not make ${fixture} executable for BOTTEGA_ORCH: ${cause instanceof Error ? cause.message : String(cause)}. The file must be executable for BOTTEGA_ORCH. Run \`chmod +x hub/test/project-register.ts\` or restore Git's mode with \`git checkout -- hub/test/project-register.ts\`.`,
      { cause },
    )
  }
}
process.env.BOTTEGA_ORCH = fixture

const { directory: databaseDir } = mintTestHubDatabase(FROZEN_STATE_NAMES.hubDatabase)
const originalConfigHome = process.env[CONFIG_HOME_ENV]
const originalHarnessEnvFile = process.env[HARNESS_ENV_FILE_ENV]
const originalHostedUrl = process.env.BOTTEGA_HOSTED_URL
const originalRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
const originalStateHome = process.env[STATE_HOME_ENV]
const configDir = mkdtempSync(join(tmpdir(), 'hub-test-config-'))
process.env[CONFIG_HOME_ENV] = configDir
// Best-effort contention and hold logs must land in a throwaway root, never the operator's.
const stateDir = mkdtempSync(join(tmpdir(), 'hub-test-state-'))
process.env[STATE_HOME_ENV] = stateDir
const installationHubDirectory = join(stateDir, 'hub')
mkdirSync(installationHubDirectory)
symlinkSync(
  process.env.BOTTEGA_HUB_DB!,
  join(installationHubDirectory, FROZEN_STATE_NAMES.hubDatabase),
)
machineId(HUB_MIGRATION_BACKFILL_VALUES.machine_id)
process.env[HARNESS_ENV_FILE_ENV] = ''
delete process.env.BOTTEGA_HOSTED_URL
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
  if (originalHostedUrl === undefined) delete process.env.BOTTEGA_HOSTED_URL
  else process.env.BOTTEGA_HOSTED_URL = originalHostedUrl
  if (originalRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = originalRecordApiUrl
  if (originalStateHome === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = originalStateHome
  rmSync(configDir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(databaseDir, { recursive: true, force: true })
})
