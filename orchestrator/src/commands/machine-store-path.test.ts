import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveOrchestratorDatabase } from '../../../shared/state-directory.ts'
import { machineStorePathCommand } from './machine-store-path.ts'

test('resolves the store path without creating the store', () => {
  const stateHome = mkdtempSync(join(tmpdir(), 'machine-store-path-'))
  try {
    const environment = { BOTTEGA_STATE_HOME: stateHome }
    const stdout: string[] = []

    machineStorePathCommand({ write: (value) => stdout.push(value) }, environment)

    const store = resolveOrchestratorDatabase(environment)
    expect(stdout).toEqual([`${store}\n`])
    expect(existsSync(store)).toBeFalse()
  } finally {
    rmSync(stateHome, { recursive: true, force: true })
  }
})
