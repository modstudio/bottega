// concern: cleanup-sweep
/** Runs bounded outbox maintenance and reports each independent step. */
import type { Database } from 'bun:sqlite'
import { db, writableDb } from '../database/db.ts'
import {
  drainDeliveredOutboxPayloads,
  drainSupersededOutboxRows,
  OUTBOX_PRUNE_CHUNK_SIZE,
  pruneSupersededOutboxRows,
  releaseDeliveredOutboxPayloads,
} from '../record/outbox-prune.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { reportMaintenanceStep } from './cleanup-sweep-report.ts'

export type OutboxMaintenance = {
  drain: typeof drainSupersededOutboxRows
  release: typeof drainDeliveredOutboxPayloads
}
export const DEFAULT_OUTBOX_MAINTENANCE: OutboxMaintenance = {
  drain: drainSupersededOutboxRows,
  release: drainDeliveredOutboxPayloads,
}
const TIME_BOUND_MS = 2_000

function dryRun(database: Database, presentation: CleanupPresentation): void {
  reportMaintenanceStep(
    'outbox prune',
    presentation,
    () => pruneSupersededOutboxRows(database, { limit: OUTBOX_PRUNE_CHUNK_SIZE, dryRun: true }),
    (result) => `outbox would prune ${result.deleted} rows`,
  )
  reportMaintenanceStep(
    'outbox release',
    presentation,
    () =>
      releaseDeliveredOutboxPayloads(database, {
        now: Date.now(),
        limit: OUTBOX_PRUNE_CHUNK_SIZE,
        dryRun: true,
      }),
    (result) => `outbox would release ${result.released} payloads`,
  )
}

export function maintainOutboxForSweep(
  isDryRun: boolean,
  presentation: CleanupPresentation,
  maintenance: OutboxMaintenance,
): void {
  const database = isDryRun ? db() : writableDb()
  if (isDryRun) {
    dryRun(database, presentation)
    return
  }
  reportMaintenanceStep(
    'outbox prune',
    presentation,
    () => maintenance.drain(database, { timeBoundMs: TIME_BOUND_MS }),
    (result) =>
      `outbox pruned ${result.deleted} rows; backlog remains ${result.more ? 'yes' : 'no'}`,
  )
  reportMaintenanceStep(
    'outbox release',
    presentation,
    () => maintenance.release(database, { now: Date.now(), timeBoundMs: TIME_BOUND_MS }),
    (result) =>
      `outbox released ${result.released} payloads; backlog remains ${result.more ? 'yes' : 'no'}`,
  )
}
