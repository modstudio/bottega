import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveHubDatabase, resolveOrchestratorDatabase } from '../../../shared/state-directory.ts'
import { machineStorePathCommand } from './machine-store-path.ts'

test('resolves both store paths without creating either store', () => {
  const stateHome = mkdtempSync(join(tmpdir(), 'machine-store-path-'))
  try {
    const environment = { BOTTEGA_STATE_HOME: stateHome }
    const stdout: string[] = []

    machineStorePathCommand({ write: (value) => stdout.push(value) }, environment)

    const orchestratorStore = resolveOrchestratorDatabase(environment)
    const hubStore = resolveHubDatabase(environment)
    expect(stdout).toEqual([`${orchestratorStore}\n`, `${hubStore}\n`])
    expect(existsSync(orchestratorStore)).toBeFalse()
    expect(existsSync(hubStore)).toBeFalse()
  } finally {
    rmSync(stateHome, { recursive: true, force: true })
  }
})
