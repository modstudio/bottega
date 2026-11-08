// concern: durable machine update intent
/** Persists enough pre-update state to recover after the lock holder dies. */

import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolveHubDatabase, resolveOrchestratorDatabase } from '../../../shared/state-directory.ts'
import { machineUpdateIntentPath } from '../../../shared/update-lock.ts'
import type { StoreJournalPositions, SwappedUpdateState } from './machine-update-recovery.ts'

export type MachineUpdateIntent = {
  before: StoreJournalPositions
  swapped: SwappedUpdateState
}

function appliedPosition(path: string, table: string): number {
  if (!existsSync(path)) return 0
  const database = new Database(path, { readonly: true, create: false })
  try {
    return table === 'orch_migrations'
      ? database.query<{ count: number }, []>('SELECT COUNT(*) count FROM orch_migrations').get()!
          .count
      : database.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version
  } finally {
    database.close()
  }
}

export function localStoreJournalPositions(
  env: Record<string, string | undefined> = process.env,
): StoreJournalPositions {
  return {
    orchestrator: appliedPosition(resolveOrchestratorDatabase(env), 'orch_migrations'),
    hub: appliedPosition(resolveHubDatabase(env), 'hub_migrations'),
  }
}

export function readMachineUpdateIntent(
  env: Record<string, string | undefined> = process.env,
): MachineUpdateIntent | null {
  try {
    return JSON.parse(readFileSync(machineUpdateIntentPath(env), 'utf8')) as MachineUpdateIntent
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`machine update intent could not be read: ${String(error)}`)
  }
}

export function writeMachineUpdateIntent(
  intent: MachineUpdateIntent,
  env: Record<string, string | undefined> = process.env,
): void {
  writeFileSync(machineUpdateIntentPath(env), JSON.stringify(intent), { mode: 0o600 })
}

export function clearMachineUpdateIntent(
  env: Record<string, string | undefined> = process.env,
): void {
  rmSync(machineUpdateIntentPath(env), { force: true })
}
