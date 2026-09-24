import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME_ENV } from '../../shared/config-directory.ts'

const originalConfigHome = process.env[CONFIG_HOME_ENV]
const originalRecordApiUrl = process.env.ORCH_RECORD_API_URL
const configDir = mkdtempSync(join(tmpdir(), 'retrieval-test-config-'))
process.env[CONFIG_HOME_ENV] = configDir
delete process.env.ORCH_RECORD_API_URL

afterAll(() => {
  if (originalConfigHome === undefined) delete process.env[CONFIG_HOME_ENV]
  else process.env[CONFIG_HOME_ENV] = originalConfigHome
  if (originalRecordApiUrl === undefined) delete process.env.ORCH_RECORD_API_URL
  else process.env.ORCH_RECORD_API_URL = originalRecordApiUrl
  rmSync(configDir, { recursive: true, force: true })
})
