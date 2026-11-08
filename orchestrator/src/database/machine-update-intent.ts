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
import { z } from 'zod'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveHubDatabase, resolveOrchestratorDatabase } from '../../../shared/state-directory.ts'
import { machineUpdateIntentPath } from '../../../shared/update-lock.ts'
import type { StoreJournalPositions, SwappedUpdateState } from './machine-update-recovery.ts'

export type MachineUpdateIntent = {
  before: StoreJournalPositions
  swapped: SwappedUpdateState
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

function appliedPosition(path: string, table: string): number | null {
  if (!existsSync(path)) return null
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
): StoreJournalPositions | null {
  try {
    const orchestrator = appliedPosition(resolveOrchestratorDatabase(env), 'orch_migrations')
    const hub = appliedPosition(resolveHubDatabase(env), 'hub_migrations')
    return orchestrator === null || hub === null ? null : { orchestrator, hub }
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
  } catch (error) {
    try {
      closeSync(descriptor)
    } catch {}
    throw error
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function clearMachineUpdateIntent(
  env: Record<string, string | undefined> = process.env,
): void {
  rmSync(machineUpdateIntentPath(env), { force: true })
}
