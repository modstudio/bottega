// concern: record-session
/** Owns access to the locally stored record session. Must not know run phases. */
import type { Database } from 'bun:sqlite'
import { db } from './db.ts'
import {
  bearerHeaders,
  RECORD_SESSION_KEY,
  RECORD_SIGN_IN_REMEDY,
  recordAuth,
} from './record-auth.ts'

export function storedRecordToken(local: Database = db()): string | null {
  return (
    local
      .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
      .get(RECORD_SESSION_KEY)?.value ?? null
  )
}

export async function currentRecordUserSession(url: string, local: Database = db()) {
  const token = storedRecordToken(local)
  if (!token) throw new Error(RECORD_SIGN_IN_REMEDY)
  const current = await recordAuth(url).api.getSession({ headers: bearerHeaders(token) })
  if (!current) throw new Error(RECORD_SIGN_IN_REMEDY)
  return {
    token,
    user: current.user,
    session: current.session,
    activeSpaceId: current.session.activeOrganizationId ?? null,
  }
}

export async function currentRecordSession(url: string, local: Database = db()) {
  const current = await currentRecordUserSession(url, local)
  if (!current.activeSpaceId) throw new Error(RECORD_SIGN_IN_REMEDY)
  return { ...current, activeSpaceId: current.activeSpaceId }
}
