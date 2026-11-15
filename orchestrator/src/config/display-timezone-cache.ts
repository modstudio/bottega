// concern: display timezone configuration cache
/** Owns the user-global display time zone cache consumed by local operator surfaces. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDisplayTimezone } from '../../../shared/machine-config.ts'
import {
  autonomyContextDirectory,
  type StateEnvironment,
} from '../../../shared/state-directory.ts'
import { writeCacheFile } from './atomic-cache-file.ts'

type CachedUserDisplay = {
  version: 1
  displayTimezone: string | null
}

const displayTimezoneCachePath = (env: StateEnvironment) =>
  join(autonomyContextDirectory(env), 'user.display.json')

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

export function refreshDisplayTimezoneCache(
  displayTimezone: string | null,
  env: StateEnvironment = process.env,
): string | null {
  try {
    writeCachedDisplayTimezone(displayTimezone, env)
    return null
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const warning = `warning: could not refresh display time zone cache: ${reason}`
    console.error(warning)
    return warning
  }
}
