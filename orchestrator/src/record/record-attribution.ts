// concern: record-attribution
/** Resolves run attribution without making dispatch depend on the hosted record. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { recordApiClient } from './record-api-client.ts'
import { storedRecordToken } from './record-session.ts'

const ATTRIBUTION_FAILURE_KEY = 'record_attribution_failure'

function writeFailure(local: Database, detail: string | null): void {
  if (detail === null) {
    const present = local
      .query<{ present: number }, [string]>('SELECT 1 AS present FROM schema_meta WHERE key=?')
      .get(ATTRIBUTION_FAILURE_KEY)
    if (!present) return
    local.query('DELETE FROM schema_meta WHERE key=?').run(ATTRIBUTION_FAILURE_KEY)
    return
  }
  local
    .query(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(ATTRIBUTION_FAILURE_KEY, detail)
}

export function recordAttributionFailure(local: Database = db()): string | null {
  return (
    local
      .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
      .get(ATTRIBUTION_FAILURE_KEY)?.value ?? null
  )
}

/** Absence is expected; configured identity paths are attempted API-first and diagnosed on failure. */
export async function signedInRecordUserId(local: Database = db()): Promise<string | null> {
  let token: string | null
  try {
    token = storedRecordToken(local)
  } catch (error) {
    writeFailure(
      local,
      `stored record session: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
  if (!token) {
    writeFailure(local, null)
    return null
  }

  try {
    const id = String((await recordApiClient().whoami()).user.id)
    writeFailure(local, null)
    return id
  } catch (error) {
    writeFailure(local, `record API: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/** A pre-reserved run keeps the attribution recorded when its placeholder was created. */
export async function startedByUserIdForRun(
  reserved: boolean,
  local: Database = db(),
): Promise<string | null> {
  if (reserved) return null
  return signedInRecordUserId(local)
}
