// concern: record-attribution
/** Resolves run attribution without making dispatch depend on the hosted record. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { recordApiClient } from './record-api-client.ts'
import { storedRecordToken } from './record-session.ts'

/** Absence is expected; configured identity paths are attempted API-first and diagnosed on failure. */
export async function signedInRecordUserId(local: Database = db()): Promise<string | null> {
  let token: string | null
  try {
    token = storedRecordToken(local)
  } catch {
    return null
  }
  if (!token) return null

  try {
    return String((await recordApiClient().whoami()).user.id)
  } catch {
    return null
  }
}
