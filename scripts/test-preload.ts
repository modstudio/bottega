import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FROZEN_STATE_NAMES } from '../shared/brand.ts'
import { CONFIG_HOME_ENV } from '../shared/config-directory.ts'
import { refusal, renderRefusal } from '../shared/refusal.ts'

const originalConfigHome = process.env[CONFIG_HOME_ENV]
const originalOrchestratorDatabase = process.env.BOTTEGA_ORCHESTRATOR_DB
const originalRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
const KEYCHAIN_PLATFORM_KEY = Symbol.for('orch.keychain-platform')
const keychainPlatformHolder = globalThis as typeof globalThis & {
  [KEYCHAIN_PLATFORM_KEY]?: string
}
const originalKeychainPlatform = keychainPlatformHolder[KEYCHAIN_PLATFORM_KEY]
const configDir = mkdtempSync(join(tmpdir(), 'root-test-config-'))
const databaseDir = mkdtempSync(join(tmpdir(), 'root-test-database-'))
const databasePath = join(databaseDir, FROZEN_STATE_NAMES.orchestratorDatabase)
process.env[CONFIG_HOME_ENV] = configDir
process.env.BOTTEGA_ORCHESTRATOR_DB = databasePath
delete process.env.BOTTEGA_RECORD_API_URL
keychainPlatformHolder[KEYCHAIN_PLATFORM_KEY] = 'darwin'

// DB_PATH is read once per process, so pin it before any root test file can load db.ts.
const { DB_PATH } = await import('../orchestrator/src/database/database-location.ts')
if (DB_PATH !== databasePath) {
  throw new Error(
    renderRefusal(
      refusal(
        `root test preload refuses to run: database-location.ts resolved ${DB_PATH}, not the fixture store ${databasePath}\n` +
          'invariant: A root test batch only ever loads the store its own preload created.',
        {
          kind: 'edit',
          text: 'bun test from the repository root with BOTTEGA_ORCHESTRATOR_DB unset',
        },
      ),
    ),
  )
}

afterAll(() => {
  if (originalConfigHome === undefined) delete process.env[CONFIG_HOME_ENV]
  else process.env[CONFIG_HOME_ENV] = originalConfigHome
  if (originalOrchestratorDatabase === undefined) delete process.env.BOTTEGA_ORCHESTRATOR_DB
  else process.env.BOTTEGA_ORCHESTRATOR_DB = originalOrchestratorDatabase
  if (originalRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = originalRecordApiUrl
  if (originalKeychainPlatform === undefined) delete keychainPlatformHolder[KEYCHAIN_PLATFORM_KEY]
  else keychainPlatformHolder[KEYCHAIN_PLATFORM_KEY] = originalKeychainPlatform
  rmSync(configDir, { recursive: true, force: true })
  rmSync(databaseDir, { recursive: true, force: true })
})
