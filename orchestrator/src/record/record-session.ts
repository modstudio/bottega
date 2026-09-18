// concern: record-session
/** Owns access to the locally stored record session. Must not know run phases. */
import type { Database } from 'bun:sqlite'
import { SQL } from 'bun'
import { RECORD_ACTIVE_SPACE_REMEDY } from '../../../shared/record-remedies.ts'
import {
  readRecordSessionToken,
  type SecurityRunner,
  writeRecordSessionToken,
} from '../../../shared/record-session.ts'
import { DATABASE_RESOLUTION, db, writeTransaction } from '../database/db.ts'
import {
  activeMembershipSpace,
  bearerHeaders,
  RECORD_SESSION_KEY,
  RECORD_SIGN_IN_REMEDY,
  recordAuth,
} from './record-auth.ts'

export function recordUserSessionFromMemberships<
  User,
  Session extends { activeOrganizationId?: string | null },
>(token: string, current: { user: User; session: Session }, membershipSpaceIds: readonly string[]) {
  return {
    token,
    user: current.user,
    session: current.session,
    activeSpaceId: activeMembershipSpace(
      current.session.activeOrganizationId ?? null,
      membershipSpaceIds,
    ),
  }
}

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
  const client = new SQL(url)
  try {
    const memberships = await client.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${current.user.id}, true)`
      await tx`SELECT set_config('app.space_id', '', true)`
      return tx`
        SELECT space_id FROM membership
        WHERE user_id=${current.user.id}::uuid
      `
    })
    return recordUserSessionFromMemberships(
      token,
      current,
      memberships.map((row: Record<string, unknown>) => String(row.space_id)),
    )
  } finally {
    await client.close()
  }
}

export async function currentRecordSession(
  url: string,
  local: Database = db(),
  runner?: SecurityRunner,
) {
  const current = await currentRecordUserSession(url, local, runner)
  if (!current.activeSpaceId) throw new Error(RECORD_ACTIVE_SPACE_REMEDY)
  return { ...current, activeSpaceId: current.activeSpaceId }
}
