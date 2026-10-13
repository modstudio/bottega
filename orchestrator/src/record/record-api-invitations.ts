// concern: record-api-invitations
/** Exposes the authenticated user's invitation list. Must not own invitation queries. */

import type { Hono } from 'hono'
import type { RecordIdentity } from './record-auth.ts'
import type { HostedRecordInvitation } from './record-invitations.ts'

type InvitationEnvironment = {
  Variables: { identity: RecordIdentity; destinationSpaceId?: string }
}

export type RecordInvitationRouteDeps = {
  recordUrl: string
  listInvitations(input: {
    url: string
    userId: string
    email: string
  }): Promise<HostedRecordInvitation[]>
}

export function registerRecordInvitationRoute(
  app: Hono<InvitationEnvironment>,
  deps: RecordInvitationRouteDeps,
): void {
  app.get('/v1/invitations', async (context) => {
    const identity = context.get('identity')
    const email = identity.user.email
    if (typeof email !== 'string' || !email)
      return context.json({ error: 'record identity has no email' }, 500)
    return context.json(
      await deps.listInvitations({
        url: deps.recordUrl,
        userId: identity.user.id,
        email,
      }),
    )
  })
}
