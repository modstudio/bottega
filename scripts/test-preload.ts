import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME_ENV } from '../shared/config-directory.ts'

const originalConfigHome = process.env[CONFIG_HOME_ENV]
const originalOrchestratorDatabase = process.env.BOTTEGA_ORCHESTRATOR_DB
const originalRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
const configDir = mkdtempSync(join(tmpdir(), 'root-test-config-'))
const databaseDir =
  originalOrchestratorDatabase === undefined
    ? mkdtempSync(join(tmpdir(), 'root-test-database-'))
    : null
process.env[CONFIG_HOME_ENV] = configDir
if (databaseDir) process.env.BOTTEGA_ORCHESTRATOR_DB = join(databaseDir, 'orchestrator.db')
delete process.env.BOTTEGA_RECORD_API_URL

afterAll(() => {
  if (originalConfigHome === undefined) delete process.env[CONFIG_HOME_ENV]
  else process.env[CONFIG_HOME_ENV] = originalConfigHome
  if (originalOrchestratorDatabase === undefined) delete process.env.BOTTEGA_ORCHESTRATOR_DB
  else process.env.BOTTEGA_ORCHESTRATOR_DB = originalOrchestratorDatabase
  if (originalRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = originalRecordApiUrl
  rmSync(configDir, { recursive: true, force: true })
  if (databaseDir) rmSync(databaseDir, { recursive: true, force: true })
})
