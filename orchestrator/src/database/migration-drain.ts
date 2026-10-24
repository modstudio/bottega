// concern: migration drain marker
/** Stores and interprets the machine-wide migration drain that blocks new run admission. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { pidAlive, processStartTime } from '../../../shared/process-identity.ts'
import { contentionTableExists, insertContention } from './contention.ts'
import { tryWriteContention, writeTransaction } from './db.ts'

const MIGRATION_DRAIN_KEY = 'migration_drain'

export type MigrationDrain = {
  migration: string
  phase: 'draining' | 'migrating'
  pid: number
  startTime: string | null
}

export type MigrationDrainLiveness =
  | { state: 'live' }
  | { state: 'stale'; reason: string }
  | { state: 'unknown'; reason: string }

class MigrationDispatchRefusal extends Error {
  readonly migrationDispatchRefusal = true

  constructor(
    message: string,
    readonly contention: Parameters<typeof tryWriteContention>[0],
  ) {
    super(message)
  }
}

/** Persist a drain refusal after a surrounding claim transaction has aborted. */
export function recordMigrationDispatchRefusal(
  cause: unknown,
  opts?: { busyTimeoutMs?: number },
): boolean {
  if (
    !cause ||
    typeof cause !== 'object' ||
    !('migrationDispatchRefusal' in cause) ||
    !('contention' in cause)
  )
    return false
  tryWriteContention((cause as MigrationDispatchRefusal).contention, opts)
  return true
}

export function migrationDrainLiveness(
  marker: MigrationDrain,
  observe: {
    pidAlive(pid: number): boolean
    processStartTime(pid: number): string | null
  },
): MigrationDrainLiveness {
  if (!observe.pidAlive(marker.pid)) {
    return { state: 'stale', reason: `dead holder pid ${marker.pid}` }
  }
  if (marker.startTime === null) {
    return { state: 'unknown', reason: `holder pid ${marker.pid} has no recorded start time` }
  }
  const actual = observe.processStartTime(marker.pid)
  if (actual === null) {
    return { state: 'unknown', reason: `holder pid ${marker.pid} start time is unavailable` }
  }
  if (actual !== marker.startTime) {
    return {
      state: 'stale',
      reason: `pid ${marker.pid} start time changed from ${marker.startTime} to ${actual}`,
    }
  }
  return { state: 'live' }
}

function parseMigrationDrain(value: string): MigrationDrain | null {
  try {
    const parsed = JSON.parse(value) as Partial<MigrationDrain>
    return typeof parsed.migration === 'string' &&
      Number.isSafeInteger(parsed.pid) &&
      Number(parsed.pid) > 0 &&
      (typeof parsed.startTime === 'string' || parsed.startTime === null)
      ? {
          migration: parsed.migration,
          phase: parsed.phase === 'migrating' ? 'migrating' : 'draining',
          pid: Number(parsed.pid),
          startTime: parsed.startTime,
        }
      : null
  } catch {
    return null
  }
}

export function migrationDrain(database: Database): MigrationDrain | null {
  const value = database
    .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
    .get(MIGRATION_DRAIN_KEY)?.value
  return value === undefined ? null : parseMigrationDrain(value)
}

export function activeMigrationDrain(
  database: Database,
  observe: {
    pidAlive(pid: number): boolean
    processStartTime(pid: number): string | null
  } = { pidAlive, processStartTime },
): {
  marker: MigrationDrain
  liveness: Exclude<MigrationDrainLiveness, { state: 'stale' }>
} | null {
  const marker = migrationDrain(database)
  if (!marker) return null
  const liveness = migrationDrainLiveness(marker, observe)
  return liveness.state === 'stale' ? null : { marker, liveness }
}

export function assertMigrationDispatchAllowed(database: Database, existingChain = false): void {
  const active = activeMigrationDrain(database)
  if (!active) return
  if (existingChain && active.marker.phase === 'draining') return
  const holder =
    active.liveness.state === 'unknown'
      ? `${active.liveness.reason}; holder pid ${active.marker.pid}`
      : `holder pid ${active.marker.pid}`
  const contention = {
    resourceKind: 'store',
    resourceKey: 'migration-drain',
    eventKind: 'refusal',
    cause: `refused dispatch during ${active.marker.phase} for ${active.marker.migration}: ${holder}`,
  } as const
  const refusal = new MigrationDispatchRefusal(
    `refusing dispatch while ${active.marker.phase} for migration ${active.marker.migration} (${holder}); ` +
      `re-dispatch after ${PLATFORM_SLUG} machine update finishes`,
    contention,
  )
  recordMigrationDispatchRefusal(refusal)
  throw refusal
}

export function migrationDrainForUpdate(
  database: Database,
  observe: {
    pidAlive(pid: number): boolean
    processStartTime(pid: number): string | null
  } = { pidAlive, processStartTime },
): MigrationDrain | null {
  const stored = database
    .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
    .get(MIGRATION_DRAIN_KEY)?.value
  const marker = stored === undefined ? null : parseMigrationDrain(stored)
  if (!marker) return null
  const liveness = migrationDrainLiveness(marker, observe)
  if (liveness.state !== 'stale') return marker
  // Remove exactly the marker classified as stale, never a replacement another
  // update installed after this read.
  const reclaimed = writeTransaction(() => {
    const removed = database
      .query('DELETE FROM schema_meta WHERE key=? AND value=?')
      .run(MIGRATION_DRAIN_KEY, stored!)
    if (removed.changes === 0) return false
    if (contentionTableExists(database)) {
      insertContention(database, {
        resourceKind: 'store',
        resourceKey: 'migration-drain',
        eventKind: 'invalidation',
        cause: `reclaimed stale migration drain for ${marker.migration}: ${liveness.reason}`,
      })
    }
    return true
  }, database)
  return reclaimed ? null : migrationDrain(database)
}

export function setMigrationDrain(
  database: Database,
  migration: string,
  phase: MigrationDrain['phase'] = 'draining',
  holder: Pick<MigrationDrain, 'pid' | 'startTime'> = {
    pid: process.pid,
    startTime: processStartTime(process.pid),
  },
): void {
  const marker: MigrationDrain = { migration, phase, ...holder }
  writeTransaction(() => {
    const inserted = database
      .query('INSERT OR IGNORE INTO schema_meta(key,value) VALUES (?,?)')
      .run(MIGRATION_DRAIN_KEY, JSON.stringify(marker))
    if (inserted.changes !== 1) {
      const active = migrationDrain(database)
      throw new Error(
        `migration drain is already active for ${active?.migration ?? 'an unknown migration'} ` +
          `(holder pid ${active?.pid ?? 'unknown'})`,
      )
    }
  }, database)
}

/** Move a marker owned by this process between admission phases. */
export function setMigrationDrainPhase(database: Database, phase: MigrationDrain['phase']): void {
  writeTransaction(() => {
    const marker = migrationDrain(database)
    if (!marker || marker.pid !== process.pid) {
      throw new Error(
        `cannot set migration drain phase to ${phase}: marker is held by pid ${marker?.pid ?? 'unknown'}`,
      )
    }
    database
      .query('UPDATE schema_meta SET value=? WHERE key=?')
      .run(JSON.stringify({ ...marker, phase }), MIGRATION_DRAIN_KEY)
  }, database)
}

/** Remove the marker only while this process holds it, never another update's. */
export function clearMigrationDrain(database: Database): void {
  writeTransaction(() => {
    const marker = migrationDrain(database)
    if (marker?.pid !== process.pid) return
    database.query('DELETE FROM schema_meta WHERE key=?').run(MIGRATION_DRAIN_KEY)
  }, database)
}
