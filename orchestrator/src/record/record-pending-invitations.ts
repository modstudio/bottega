// concern: record-pending-invitations
/** Owns signed-in users' pending hosted invitations. Must not know HTTP or CLI presentation. */

import { recordPool } from './record-pool.ts'

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
  return recordPool(input.url).begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${input.userId}, true)`
    await tx`SELECT set_config('app.space_id', '', true)`
    const rows = await tx`
        SELECT i.id, i.space_id, i.role, u.email AS inviter_email, i.expires_at
        FROM invitation i JOIN "user" u ON u.id=i.inviter_id
        WHERE i.status='pending' AND i.expires_at > now()
          AND lower(i.email)=lower(${input.email})
        ORDER BY i.expires_at, i.id
      `
    const invitations: HostedRecordInvitation[] = []
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
        expiresAt: new Date(String(row.expires_at)).toISOString(),
      })
    }
    return invitations
  })
}
