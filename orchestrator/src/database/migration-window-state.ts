// concern: store-open migration window state
/** Reads the machine-wide marker for a live additive migration window. */

import type { Database } from 'bun:sqlite'
import { pidAlive, processStartTime } from '../../../shared/process-identity.ts'

export const MIGRATION_WINDOW_KEY = 'migration_window'

export type MigrationWindow = {
  migration: string
  pid: number
  startTime: string | null
}

export type MigrationWindowLiveness =
  | { state: 'live' }
  | { state: 'stale'; reason: string }
  | { state: 'unknown'; reason: string }

export function migrationWindowLiveness(
  marker: MigrationWindow,
  observe: {
    pidAlive(pid: number): boolean
    processStartTime(pid: number): string | null
  },
): MigrationWindowLiveness {
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

export function parseMigrationWindow(value: string): MigrationWindow | null {
  try {
    const parsed = JSON.parse(value) as Partial<MigrationWindow>
    return typeof parsed.migration === 'string' &&
      Number.isSafeInteger(parsed.pid) &&
      Number(parsed.pid) > 0 &&
      (typeof parsed.startTime === 'string' || parsed.startTime === null)
      ? {
          migration: parsed.migration,
          pid: Number(parsed.pid),
          startTime: parsed.startTime,
        }
      : null
  } catch {
    return null
  }
}

export function migrationWindow(database: Database): MigrationWindow | null {
  const value = database
    .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
    .get(MIGRATION_WINDOW_KEY)?.value
  return value === undefined ? null : parseMigrationWindow(value)
}

export function activeMigrationWindow(
  database: Database,
  observe: {
    pidAlive(pid: number): boolean
    processStartTime(pid: number): string | null
  } = { pidAlive, processStartTime },
): {
  marker: MigrationWindow
  liveness: Exclude<MigrationWindowLiveness, { state: 'stale' }>
} | null {
  const marker = migrationWindow(database)
  if (!marker) return null
  const liveness = migrationWindowLiveness(marker, observe)
  return liveness.state === 'stale' ? null : { marker, liveness }
}
