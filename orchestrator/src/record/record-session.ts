// concern: record-session
/** Owns access to the locally stored record session. Must not know run phases. */
import type { Database } from 'bun:sqlite'
import {
  RECORD_ACTIVE_SPACE_REMEDY,
  RECORD_SIGN_IN_REMEDY,
} from '../../../shared/record-remedies.ts'
import { recordRequestHeaders } from '../../../shared/record-request-headers.ts'
import type { SecurityRunner } from '../../../shared/record-session.ts'
import { db } from '../database/db.ts'
import { activeMembershipSpace } from './record-membership.ts'
import { recordPool } from './record-pool.ts'
import { storedRecordToken } from './record-token.ts'

export { storedRecordToken, storedRecordTokenAsync } from './record-token.ts'

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

export function recordSessionPresent(): boolean {
  return storedRecordToken() !== null
}

export async function currentRecordUserSession(
  url: string,
  local: Database = db(),
  runner?: SecurityRunner,
) {
  const token = storedRecordToken(local, runner)
  if (!token) throw new Error(RECORD_SIGN_IN_REMEDY)
  const { noSpaceBuiltIns, recordAuth } = await import('./record-auth.ts')
  const auth = recordAuth(url, process.env, undefined, undefined, undefined, noSpaceBuiltIns)
  const current = await auth.api
    .getSession({ headers: recordRequestHeaders({ bearerToken: token }) })
    .finally(() => auth.close())
  if (!current) throw new Error(RECORD_SIGN_IN_REMEDY)
  const memberships = await recordPool(url).begin(async (tx) => {
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
