import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FROZEN_STATE_NAMES } from '../shared/brand.ts'
import { CONFIG_HOME_ENV } from '../shared/config-directory.ts'

const originalConfigHome = process.env[CONFIG_HOME_ENV]
const originalOrchestratorDatabase = process.env.BOTTEGA_ORCHESTRATOR_DB
const originalRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
const configDir = mkdtempSync(join(tmpdir(), 'root-test-config-'))
const databaseDir = mkdtempSync(join(tmpdir(), 'root-test-database-'))
process.env[CONFIG_HOME_ENV] = configDir
process.env.BOTTEGA_ORCHESTRATOR_DB = join(databaseDir, FROZEN_STATE_NAMES.orchestratorDatabase)
delete process.env.BOTTEGA_RECORD_API_URL

afterAll(() => {
  if (originalConfigHome === undefined) delete process.env[CONFIG_HOME_ENV]
  else process.env[CONFIG_HOME_ENV] = originalConfigHome
  if (originalOrchestratorDatabase === undefined) delete process.env.BOTTEGA_ORCHESTRATOR_DB
  else process.env.BOTTEGA_ORCHESTRATOR_DB = originalOrchestratorDatabase
  if (originalRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = originalRecordApiUrl
  rmSync(configDir, { recursive: true, force: true })
  rmSync(databaseDir, { recursive: true, force: true })
})
