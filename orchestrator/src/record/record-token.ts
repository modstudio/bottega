// concern: record-session token
/** Owns access to the locally stored record token. Must not know hosted authentication. */
import type { Database } from 'bun:sqlite'
import {
  legacyRecordSessionReadOnlyRefusal,
  readRecordSessionToken,
  readRecordSessionTokenAsync,
  type SecurityRunner,
  writeRecordSessionToken,
} from '../../../shared/record-session.ts'
import { DATABASE_RESOLUTION, db, writeTransaction } from '../database/db.ts'
import { RECORD_SESSION_KEY } from './record-token-key.ts'

export function storedRecordToken(
  local: Database = db(),
  runner?: SecurityRunner,
  mayMigrate = !DATABASE_RESOLUTION.linkedWorktreeBinary,
): string | null {
  const keychainToken = readRecordSessionToken(runner)
  if (keychainToken || !mayMigrate) return keychainToken
  const legacy = local
    .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
    .get(RECORD_SESSION_KEY)?.value
  if (!legacy) return null
  try {
    writeTransaction(() => {
      writeRecordSessionToken(legacy, runner)
      local.query('DELETE FROM schema_meta WHERE key=?').run(RECORD_SESSION_KEY)
    }, local)
  } catch (error) {
    if ((error as { code?: string }).code !== 'SQLITE_READONLY') throw error
    throw legacyRecordSessionReadOnlyRefusal()
  }
  return legacy
}

export async function storedRecordTokenAsync(
  local: Database = db(),
  signal?: AbortSignal,
  mayReadLegacy = !DATABASE_RESOLUTION.linkedWorktreeBinary,
): Promise<string | null> {
  const keychainToken = await readRecordSessionTokenAsync(signal)
  if (keychainToken || !mayReadLegacy) return keychainToken
  return (
    local
      .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
      .get(RECORD_SESSION_KEY)?.value ?? null
  )
}
