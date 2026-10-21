// concern: record-session
/** Owns access to the locally stored record session. Must not know run phases. */
import type { Database } from 'bun:sqlite'
import { SQL } from 'bun'
import { RECORD_ACTIVE_SPACE_REMEDY } from '../../../shared/record-remedies.ts'
import {
  readRecordSessionToken,
  readRecordSessionTokenAsync,
  type SecurityRunner,
  writeRecordSessionToken,
} from '../../../shared/record-session.ts'
import { DATABASE_RESOLUTION, db, writeTransaction } from '../database/db.ts'
import {
  activeMembershipSpace,
  bearerHeaders,
  noSpaceBuiltIns,
  RECORD_SESSION_KEY,
  RECORD_SIGN_IN_REMEDY,
  recordAuth,
} from './record-auth.ts'

const RECORD_USER_KEY = 'record_signed_in_user'

export type CachedRecordUser = { id: string; name: string | null; email: string }

export function parseCachedRecordUser(value: unknown): CachedRecordUser | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
  const email = typeof candidate.email === 'string' ? candidate.email.trim() : ''
  if (!id || !email) return null
  const name =
    typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : null
  return { id, name, email }
}

export function rememberSignedInRecordUser(
  user: Record<string, unknown>,
  local: Database = db(),
): void {
  const parsed = parseCachedRecordUser(user)
  if (!parsed) return
  local
    .query(
      `INSERT INTO schema_meta(key,value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(RECORD_USER_KEY, JSON.stringify(parsed))
}

export function cachedSignedInRecordUser(local: Database = db()): CachedRecordUser | null {
  const value = local
    .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
    .get(RECORD_USER_KEY)?.value
  if (!value) return null
  if (!storedRecordToken(local)) return null
  try {
    return parseCachedRecordUser(JSON.parse(value))
  } catch {
    return null
  }
}

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

/** The cancellable read for budgeted requests. It never migrates a legacy token, because the
 * keychain write and its transaction cannot be cancelled; storedRecordToken migrates it. */
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

export async function currentRecordUserSession(
  url: string,
  local: Database = db(),
  runner?: SecurityRunner,
) {
  const token = storedRecordToken(local, runner)
  if (!token) throw new Error(RECORD_SIGN_IN_REMEDY)
  const current = await recordAuth(
    url,
    process.env,
    undefined,
    undefined,
    undefined,
    noSpaceBuiltIns,
  ).api.getSession({ headers: bearerHeaders(token) })
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
