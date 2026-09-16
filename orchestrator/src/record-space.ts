// concern: record-space
/** Owns record membership, invitations, and active-space changes. Must not know CLI presentation. */

import { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'
import { setActiveRecordSpace } from './record-auth.ts'
import { currentRecordUserSession } from './record-session.ts'

const RECORD_INVITATION_TTL_DAYS = 7
const RECORD_SPACE_ROLES = ['member', 'owner'] as const
export type RecordSpaceRole = (typeof RECORD_SPACE_ROLES)[number]

export type RecordMembership = {
  spaceId: string
  name: string
  slug: string
  role: string
  permission: string
}

export type RecordInvitation = {
  id: string
  spaceName: string
  spaceSlug: string
  role: string
  inviterEmail: string
  expiresAt: Date
}

export function recordSpaceRole(value: string): RecordSpaceRole {
  if (value === 'member' || value === 'owner') return value
  throw new Error('record invitation role must be member or owner')
}

function resolveRecordSpace(
  value: string,
  memberships: readonly RecordMembership[],
): RecordMembership {
  const match = memberships.find(
    (membership) => membership.spaceId === value || membership.slug === value,
  )
  if (match) return match
  const slugs =
    memberships
      .map((membership) => membership.slug)
      .sort()
      .join(', ') || '(none)'
  throw new Error(
    `record space ${value} is not one of the user's memberships; available slugs: ${slugs}`,
  )
}

async function withRecordSession<T>(
  url: string,
  operation: (tx: SQL, current: Awaited<ReturnType<typeof currentRecordUserSession>>) => Promise<T>,
): Promise<T> {
  const current = await currentRecordUserSession(url)
  const client = new SQL(url)
  try {
    return await client.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${current.user.id}, true)`
      await tx`SELECT set_config('app.space_id', ${current.activeSpaceId ?? ''}, true)`
      return operation(tx, current)
    })
  } finally {
    await client.close()
  }
}

export async function recordMemberships(url: string): Promise<{
  activeSpaceId: string | null
  memberships: RecordMembership[]
}> {
  return withRecordSession(url, async (tx, current) => {
    const rows = await tx`
      SELECT s.id AS space_id, s.name, s.slug, m.role, m.permission
      FROM membership m JOIN space s ON s.id=m.space_id
      WHERE m.user_id=${current.user.id}::uuid ORDER BY s.slug
    `
    return {
      activeSpaceId: current.activeSpaceId,
      memberships: rows.map((row: Record<string, unknown>) => ({
        spaceId: String(row.space_id),
        name: String(row.name),
        slug: String(row.slug),
        role: String(row.role),
        permission: String(row.permission),
      })),
    }
  })
}

export async function switchRecordSpace(url: string, value: string): Promise<RecordMembership> {
  const current = await currentRecordUserSession(url)
  const listed = await recordMemberships(url)
  const selected = resolveRecordSpace(value, listed.memberships)
  await setActiveRecordSpace(url, current.token, selected.spaceId)
  return selected
}

export async function inviteToActiveRecordSpace(
  url: string,
  email: string,
  role: RecordSpaceRole,
): Promise<string> {
  return withRecordSession(url, async (tx, current) => {
    if (!current.activeSpaceId) {
      throw new Error('record session has no active space; run `orch record space switch <slug>`')
    }
    const callers = await tx`
      SELECT role FROM membership
      WHERE user_id=${current.user.id}::uuid AND space_id=${current.activeSpaceId}::uuid
    `
    if (callers[0]?.role !== 'owner') {
      throw new Error('record space invitation requires the owner role in the active space')
    }
    const normalizedEmail = email.toLowerCase()
    const pending = await tx`
      SELECT id FROM invitation
      WHERE space_id=${current.activeSpaceId}::uuid AND lower(email)=${normalizedEmail}
        AND status='pending' AND expires_at > now()
      ORDER BY created_at LIMIT 1
    `
    if (pending[0]) {
      throw new Error(`pending record invitation already exists: ${String(pending[0].id)}`)
    }
    const id = newRecordId()
    await tx`
      INSERT INTO invitation
        (id,space_id,email,inviter_id,role,status,expires_at,created_at)
      VALUES
        (${id}::uuid,${current.activeSpaceId}::uuid,${normalizedEmail},${current.user.id}::uuid,
         ${role},'pending',now() + (${RECORD_INVITATION_TTL_DAYS} || ' days')::interval,now())
    `
    return id
  })
}

export async function pendingRecordInvitations(url: string): Promise<RecordInvitation[]> {
  return withRecordSession(url, async (tx, current) => {
    const rows = await tx`
      SELECT i.id, i.space_id, i.role, i.expires_at, u.email AS inviter_email
      FROM invitation i JOIN "user" u ON u.id=i.inviter_id
      WHERE i.status='pending' AND i.expires_at > now()
        AND lower(i.email)=${current.user.email.toLowerCase()}
      ORDER BY i.expires_at, i.id
    `
    const invitations: RecordInvitation[] = []
    for (const row of rows) {
      const spaceId = String(row.space_id)
      await tx`SELECT set_config('app.space_id', ${spaceId}, true)`
      const spaces = await tx`SELECT name, slug FROM space WHERE id=${spaceId}::uuid`
      if (!spaces[0]) throw new Error(`record invitation space is absent: ${spaceId}`)
      invitations.push({
        id: String(row.id),
        spaceName: String(spaces[0].name),
        spaceSlug: String(spaces[0].slug),
        role: String(row.role),
        inviterEmail: String(row.inviter_email),
        expiresAt: new Date(String(row.expires_at)),
      })
    }
    return invitations
  })
}

export async function acceptRecordInvitation(url: string, invitationId: string): Promise<string> {
  return withRecordSession(url, async (tx, current) => {
    const rows = await tx`
      SELECT i.space_id, i.email, i.role, i.status, i.expires_at, u.email AS user_email
      FROM invitation i CROSS JOIN "user" u
      WHERE i.id=${invitationId}::uuid AND u.id=${current.user.id}::uuid
      FOR UPDATE OF i
    `
    const row = rows[0]
    if (!row) throw new Error(`record invitation is unavailable: ${invitationId}`)
    if (String(row.status) !== 'pending') {
      throw new Error(`record invitation is not pending: ${invitationId}`)
    }
    if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
      throw new Error(`record invitation has expired: ${invitationId}`)
    }
    if (String(row.email).toLowerCase() !== String(row.user_email).toLowerCase()) {
      throw new Error(`record invitation email does not match the signed-in user: ${invitationId}`)
    }
    const role = recordSpaceRole(String(row.role))
    const spaceId = String(row.space_id)
    await tx`SELECT set_config('app.space_id', ${spaceId}, true)`
    const existing = await tx`
      SELECT 1 FROM membership WHERE space_id=${spaceId}::uuid AND user_id=${current.user.id}::uuid
    `
    if (existing.length) throw new Error(`record user is already a member of space ${spaceId}`)
    await tx`
      INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
      VALUES (${newRecordId()}::uuid,${spaceId}::uuid,${current.user.id}::uuid,${role},'write',now())
    `
    await tx`UPDATE invitation SET status='accepted' WHERE id=${invitationId}::uuid`
    await tx`
      UPDATE session SET active_space_id=${spaceId}::uuid, updated_at=now() WHERE token=${current.token}
    `
    return spaceId
  })
}
