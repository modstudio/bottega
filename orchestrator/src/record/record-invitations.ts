// concern: record-invitations
/** Owns signed-in users' pending hosted invitations. Must not know HTTP or CLI presentation. */

import { SQL } from 'bun'

export type HostedRecordInvitation = {
  id: string
  spaceName: string
  spaceSlug: string
  role: string
  inviterEmail: string
  expiresAt: string
}

export async function listPendingRecordInvitations(input: {
  url: string
  userId: string
  email: string
}): Promise<HostedRecordInvitation[]> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${input.userId}, true)`
      await tx`SELECT set_config('app.space_id', '', true)`
      const rows = await tx`
        SELECT i.id, s.name AS space_name, s.slug AS space_slug, i.role,
          u.email AS inviter_email, i.expires_at
        FROM invitation i
        JOIN space s ON s.id=i.space_id
        JOIN "user" u ON u.id=i.inviter_id
        WHERE i.status='pending' AND i.expires_at > now()
          AND lower(i.email)=lower(${input.email})
        ORDER BY i.expires_at, i.id
      `
      return rows.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        spaceName: String(row.space_name),
        spaceSlug: String(row.space_slug),
        role: String(row.role),
        inviterEmail: String(row.inviter_email),
        expiresAt: new Date(String(row.expires_at)).toISOString(),
      }))
    })
  } finally {
    await client.close()
  }
}
