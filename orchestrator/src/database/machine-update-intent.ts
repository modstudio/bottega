// concern: durable machine update intent
/** Persists enough pre-update state to recover after the lock holder dies. */

import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { MACHINE_UPDATE_HUB_READ_BUSY_TIMEOUT_MS } from '../../../shared/call-budgets.ts'
import {
  resolveHubDatabase,
  resolveOrchestratorDatabase,
  resolveStateRoot,
  type StateEnvironment,
} from '../../../shared/state-directory.ts'
import { openReadOnlyDatabase } from './db.ts'
import type { StoreJournalPositions, SwappedUpdateState } from './machine-update-recovery.ts'

export type MachineUpdateIntent = {
  before: StoreJournalPositions
  swapped: SwappedUpdateState
}

const MACHINE_UPDATE_INTENT_FILE = 'machine-update-intent.json'

export function machineUpdateIntentPath(env: StateEnvironment): string {
  return join(resolveStateRoot(env), MACHINE_UPDATE_INTENT_FILE)
}

const STORE_JOURNAL_POSITIONS_SCHEMA = z.object({
  orchestrator: z.number().int().nonnegative(),
  hub: z.number().int().nonnegative(),
})

const MACHINE_UPDATE_INTENT_SCHEMA = z.object({
  before: STORE_JOURNAL_POSITIONS_SCHEMA,
  swapped: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('checkout'), target: z.string(), priorCommit: z.string() }),
    z.object({
      kind: z.literal('distribution'),
      installedBinary: z.string(),
      priorBinary: z.string(),
    }),
  ]),
})

function orchestratorAppliedPosition(path: string): number {
  if (!existsSync(path)) return 0
  const database = openReadOnlyDatabase(path)
  try {
    return database
      .query<{ count: number }, []>('SELECT COUNT(*) count FROM orch_migrations')
      .get()!.count
  } finally {
    database.close()
  }
}

function hubAppliedPosition(path: string): number {
  if (!existsSync(path)) return 0
  const database = new Database(path, { readonly: true, create: false })
  try {
    database.exec(`PRAGMA busy_timeout = ${MACHINE_UPDATE_HUB_READ_BUSY_TIMEOUT_MS}`)
    return database.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version
  } finally {
    database.close()
  }
}

export function localStoreJournalPositions(
  env: Record<string, string | undefined> = process.env,
): StoreJournalPositions | null {
  try {
    const orchestrator = orchestratorAppliedPosition(resolveOrchestratorDatabase(env))
    const hub = hubAppliedPosition(resolveHubDatabase(env))
    return { orchestrator, hub }
  } catch {
    return null
  }
}

export function readMachineUpdateIntent(
  env: Record<string, string | undefined> = process.env,
): MachineUpdateIntent | null {
  const path = machineUpdateIntentPath(env)
  try {
    return MACHINE_UPDATE_INTENT_SCHEMA.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(
      `machine update intent at ${path} could not be read: ${String(error)}; ` +
        `remove ${path}, then rerun ${PLATFORM_SLUG} machine update`,
    )
  }
}

export function writeMachineUpdateIntent(
  intent: MachineUpdateIntent,
  env: Record<string, string | undefined> = process.env,
): void {
  const path = machineUpdateIntentPath(env)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(descriptor, JSON.stringify(intent))
    fsyncSync(descriptor)
    closeSync(descriptor)
    renameSync(temporary, path)
    fsyncContainingDirectory(path)
  } catch (error) {
    try {
      closeSync(descriptor)
    } catch {}
    throw error
  } finally {
    rmSync(temporary, { force: true })
  }
}

function fsyncContainingDirectory(path: string): void {
  const directoryDescriptor = openSync(dirname(path), 'r')
  try {
    fsyncSync(directoryDescriptor)
  } finally {
    closeSync(directoryDescriptor)
  }
}

export function clearMachineUpdateIntent(
  env: Record<string, string | undefined> = process.env,
): void {
  const path = machineUpdateIntentPath(env)
  if (!existsSync(path)) return
  rmSync(path)
  fsyncContainingDirectory(path)
}
