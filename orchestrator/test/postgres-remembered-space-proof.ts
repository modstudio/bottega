import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import {
  bearerHeaders,
  recordAuth,
  setActiveRecordSpaceForSession,
} from '../src/record/record-auth.ts'

async function proveRememberedSpace(input: {
  actorUrl: string
  rememberedSpaceId: string
  outsiderSpaceId: string
  password: string
  executeAsOwner: (sql: string) => string
}) {
  const email = 'auth-remembered@example.test'
  // Sign-up is invitation only, so the proof invites itself before it signs up.
  input.executeAsOwner(
    `INSERT INTO invitation (id,space_id,email,inviter_id,role,status,expires_at,created_at)
     VALUES ('${newRecordId()}','${input.rememberedSpaceId}','${email}',
       (SELECT id FROM "user" ORDER BY created_at LIMIT 1),'member','pending',
       now() + interval '1 day',now());`,
  )
  const auth = recordAuth(input.actorUrl)
  const signup = await auth.api.signUpEmail({
    body: { email, name: 'Auth Remembered', password: input.password },
  })
  if (!signup.token) throw new Error('remembered-space signup has no bearer token')
  input.executeAsOwner(
    `INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
     VALUES ('${newRecordId()}','${input.rememberedSpaceId}','${signup.user.id}','member','write',now());`,
  )
  await setActiveRecordSpaceForSession(
    input.actorUrl,
    bearerHeaders(signup.token),
    input.rememberedSpaceId,
  )

  const signedIn = await auth.api.signInEmail({ body: { email, password: input.password } })
  if (!signedIn.token) throw new Error('remembered-space sign-in has no bearer token')
  const resumed = await auth.api.getSession({ headers: bearerHeaders(signedIn.token) })
  expect(resumed?.session.activeOrganizationId).toBe(input.rememberedSpaceId)
  await expect(
    setActiveRecordSpaceForSession(
      input.actorUrl,
      bearerHeaders(signedIn.token),
      input.outsiderSpaceId,
    ),
  ).rejects.toThrow('is not a member of space')
}

/**
 * The active-space proofs. They live here rather than inline so the RLS suite
 * stays under its file ceiling, following the invitation proofs' registrar.
 */
export function registerActiveSpaceProofs(input: {
  actorUrl: () => string
  tokenB: () => string
  userB: () => string
  spaceB: () => string
  rememberedSpaceId: () => string
  outsiderSpaceId: string
  password: string
  executeAsOwner: (sql: string) => string
  setToken: (token: string) => void
  memberships: () => Promise<{
    activeSpaceId: string | null
    memberships: { spaceId: string; slug: string }[]
  }>
  switchSpace: (slug: string) => Promise<{ spaceId: string }>
}) {
  test('space list and switch repair a session with no active space', async () => {
    const changed = input.executeAsOwner(`
      WITH changed AS (
        UPDATE session SET active_space_id=NULL WHERE user_id='${input.userB()}' RETURNING 1
      )
      SELECT count(*) FROM changed;
    `)
    expect(Number(changed)).toBeGreaterThanOrEqual(1)
    input.setToken(input.tokenB())
    const listed = await input.memberships()
    expect(listed.activeSpaceId).toBeNull()
    expect(listed.memberships.map((row) => row.spaceId)).toEqual([input.spaceB()])
    expect((await input.switchSpace(listed.memberships[0]!.slug)).spaceId).toBe(input.spaceB())
  })

  test('remembered space survives a new session for the same user', async () => {
    await proveRememberedSpace({
      actorUrl: input.actorUrl(),
      rememberedSpaceId: input.rememberedSpaceId(),
      outsiderSpaceId: input.outsiderSpaceId,
      password: input.password,
      executeAsOwner: input.executeAsOwner,
    })
  })
}
