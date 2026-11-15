// concern: display timezone configuration cache
/** Owns the user-global display time zone cache consumed by local operator surfaces. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDisplayTimezone } from '../../../shared/machine-config.ts'
import { concernStateDirectory, type StateEnvironment } from '../../../shared/state-directory.ts'
import { writeCacheFile } from './atomic-cache-file.ts'

export type CachedUserDisplay = {
  version: 1
  displayTimezone: string | null
}

export const displayTimezoneCachePath = (env: StateEnvironment) =>
  join(concernStateDirectory('orchestrator', env), 'autonomy-context', 'user.display.json')

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readCachedDisplayTimezone(env: StateEnvironment): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(displayTimezoneCachePath(env), 'utf8'))
    if (!object(parsed) || parsed.version !== 1) return null
    return isDisplayTimezone(parsed.displayTimezone) ? parsed.displayTimezone : null
  } catch {
    return null
  }
}

export function writeCachedDisplayTimezone(
  displayTimezone: string | null,
  env: StateEnvironment,
): void {
  const value: CachedUserDisplay = { version: 1, displayTimezone }
  writeCacheFile(displayTimezoneCachePath(env), value)
}
