// concern: record-session
/** Owns access to the locally stored record session. Must not know run phases. */
import type { Database } from 'bun:sqlite'
import {
  readRecordSessionToken,
  type SecurityRunner,
  writeRecordSessionToken,
} from '../../../shared/record-session.ts'
import { DATABASE_RESOLUTION, db, writeTransaction } from '../db.ts'
import {
  bearerHeaders,
  RECORD_SESSION_KEY,
  RECORD_SIGN_IN_REMEDY,
  recordAuth,
} from './record-auth.ts'

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
  writeTransaction(() => {
    writeRecordSessionToken(legacy, runner)
    local.query('DELETE FROM schema_meta WHERE key=?').run(RECORD_SESSION_KEY)
  }, local)
  return legacy
}

export async function currentRecordUserSession(
  url: string,
  local: Database = db(),
  runner?: SecurityRunner,
) {
  const token = storedRecordToken(local, runner)
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

export async function currentRecordSession(
  url: string,
  local: Database = db(),
  runner?: SecurityRunner,
) {
  const current = await currentRecordUserSession(url, local, runner)
  if (!current.activeSpaceId) throw new Error(RECORD_SIGN_IN_REMEDY)
  return { ...current, activeSpaceId: current.activeSpaceId }
}
