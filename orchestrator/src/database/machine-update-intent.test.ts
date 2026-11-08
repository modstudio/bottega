import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveOrchestratorDatabase, STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import {
  localStoreJournalPositions,
  machineUpdateIntentPath,
  readMachineUpdateIntent,
  writeMachineUpdateIntent,
} from './machine-update-intent.ts'

test('an intent is atomically replaced by a validated record', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-update-intent.'))
  const env = { [STATE_HOME_ENV]: root }
  const intent = {
    before: { orchestrator: 10, hub: 20 },
    swapped: { kind: 'checkout' as const, target: '/main', priorCommit: 'before' },
  }
  try {
    writeMachineUpdateIntent(intent, env)
    expect(readMachineUpdateIntent(env)).toEqual(intent)
    expect(readdirSync(root)).toEqual(['machine-update-intent.json'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an invalid intent names its path and removal remedy', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-update-intent-invalid.'))
  const env = { [STATE_HOME_ENV]: root }
  const path = machineUpdateIntentPath(env)
  try {
    writeFileSync(path, JSON.stringify({ before: { orchestrator: 'ten', hub: 20 } }))
    expect(() => readMachineUpdateIntent(env)).toThrow(
      `machine update intent at ${path} could not be read:`,
    )
    expect(() => readMachineUpdateIntent(env)).toThrow(
      `remove ${path}, then rerun ${PLATFORM_SLUG} machine update`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('absent stores have position zero and an unreadable store makes positions unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-update-positions.'))
  const env = { [STATE_HOME_ENV]: root }
  try {
    expect(localStoreJournalPositions(env)).toEqual({ orchestrator: 0, hub: 0 })
    const orchestrator = resolveOrchestratorDatabase(env)
    mkdirSync(join(root, 'orchestrator'), { recursive: true })
    writeFileSync(orchestrator, 'not a sqlite store')
    expect(localStoreJournalPositions(env)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
