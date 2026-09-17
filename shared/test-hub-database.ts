import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FROZEN_STATE_NAMES } from './brand.ts'
import { concernStateDirectory } from './state-directory.ts'

function liveHubDatabase(): string {
  return join(concernStateDirectory('hub'), FROZEN_STATE_NAMES.hubDatabase)
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Refuse any test process state in which hub would open the live task board. */
export function createTestHubDatabaseGuard(_checkout: string, liveStorePath?: string): () => void {
  const liveStore = canonicalPath(liveStorePath ?? liveHubDatabase())
  return () => {
    const configured = process.env.HUB_DB
    const resolved = configured
      ? canonicalPath(configured)
      : configured === ''
        ? '<empty>'
        : '<unset>'
    if (configured && resolved !== liveStore) return
    throw new Error(
      `test process refuses hub database: HUB_DB resolved ${resolved}; live store is ${liveStore}\n` +
        'invariant: A test suite never falls back to the live hub database.\n' +
        'cleared by: set HUB_DB to a scratch store before importing hub/src/db.ts',
    )
  }
}
