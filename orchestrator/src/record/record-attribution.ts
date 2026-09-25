// concern: record-attribution
/** Resolves run attribution without making dispatch depend on the hosted record. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { recordApiClient } from './record-api-client.ts'
import { currentRecordUserSession, storedRecordToken } from './record-session.ts'

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

function directFailure(error: unknown, url: string): string {
  let detail = error instanceof Error ? error.message : String(error)
  try {
    const password = new URL(url).password
    if (password) detail = detail.replaceAll(password, '***')
  } catch {
    // The connection attempt owns reporting an invalid URL; it has no parseable password.
  }
  return `direct record connection: ${detail}`
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

  const failures: string[] = []
  if (process.env.ORCH_RECORD_API_URL) {
    try {
      const id = String((await recordApiClient().whoami()).user.id)
      writeFailure(local, null)
      return id
    } catch (error) {
      failures.push(`record API: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    failures.push('record API: ORCH_RECORD_API_URL is not set')
  }

  const directUrl = process.env.ORCH_RECORD_URL
  if (directUrl) {
    try {
      const id = String((await currentRecordUserSession(directUrl, local)).user.id)
      writeFailure(local, null)
      return id
    } catch (error) {
      failures.push(directFailure(error, directUrl))
    }
  }

  writeFailure(local, failures.join('\n'))
  return null
}
