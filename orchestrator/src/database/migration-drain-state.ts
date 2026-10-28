// concern: migration drain marker state
/** Reads and interprets the machine-wide migration drain without owning its writes. */

import type { Database } from 'bun:sqlite'
import { pidAlive, processStartTime } from '../../../shared/process-identity.ts'

export const MIGRATION_DRAIN_KEY = 'migration_drain'

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

export function parseMigrationDrain(value: string): MigrationDrain | null {
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
