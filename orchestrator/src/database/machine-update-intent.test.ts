import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import { machineUpdateIntentPath } from '../../../shared/update-lock.ts'
import {
  localStoreJournalPositions,
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

test('journal positions are unavailable when either store is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-update-positions.'))
  try {
    expect(localStoreJournalPositions({ [STATE_HOME_ENV]: root })).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
