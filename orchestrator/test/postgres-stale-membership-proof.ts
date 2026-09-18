import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { startRecordApiServer } from '../src/record/record-api-server.ts'

const STALE_MEMBERSHIP_EMAIL = 'stale-membership@example.test'

export function registerStaleMembershipProof(input: {
  actorUrl: string
  password: string
  inviterId: () => string
  spaceId: () => string
  admin: (statement: string) => string
}): void {
  test('a removed membership invalidates the active space on the same session', async () => {
    input.admin(
      `INSERT INTO invitation
        (id,space_id,email,inviter_id,role,status,expires_at,created_at)
       VALUES ('${newRecordId()}','${input.spaceId()}','${STALE_MEMBERSHIP_EMAIL}',
         '${input.inviterId()}','member','pending',now() + interval '1 day',now());`,
    )
    const server = startRecordApiServer({
      ...process.env,
      PORT: '0',
      ORCH_RECORD_URL: input.actorUrl,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
      RECORD_HUB_URL: 'http://127.0.0.1',
    })
    const origin = `http://127.0.0.1:${server.port}`
    try {
      const signup = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: STALE_MEMBERSHIP_EMAIL,
          name: 'Stale Membership',
          password: input.password,
        }),
      })
      expect(signup.status).toBe(200)
      const created = (await signup.json()) as { token: string; user: { id: string } }
      const identityResponse = await fetch(`${origin}/v1/whoami`, {
        headers: { Authorization: `Bearer ${created.token}` },
      })
      expect(identityResponse.status).toBe(200)
      const identity = (await identityResponse.json()) as { activeSpaceId: string }

      input.admin(
        `DELETE FROM membership
         WHERE user_id='${created.user.id}'::uuid
           AND space_id='${identity.activeSpaceId}'::uuid;`,
      )
      const staleWhoami = await fetch(`${origin}/v1/whoami`, {
        headers: { Authorization: `Bearer ${created.token}` },
      })
      expect(staleWhoami.status).toBe(200)
      expect((await staleWhoami.json()) as { activeSpaceId: string | null }).toMatchObject({
        activeSpaceId: null,
      })
      const staleScopedRequest = await fetch(`${origin}/v1/runs`, {
        headers: { Authorization: `Bearer ${created.token}` },
      })
      expect(staleScopedRequest.status).toBe(409)
    } finally {
      server.stop(true)
    }
  })
}
