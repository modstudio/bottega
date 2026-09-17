import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { bearerHeaders, recordAuth, setActiveRecordSpace } from '../src/record/record-auth.ts'

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
  await setActiveRecordSpace(input.actorUrl, signup.token, input.rememberedSpaceId)

  const signedIn = await auth.api.signInEmail({ body: { email, password: input.password } })
  if (!signedIn.token) throw new Error('remembered-space sign-in has no bearer token')
  const resumed = await auth.api.getSession({ headers: bearerHeaders(signedIn.token) })
  expect(resumed?.session.activeOrganizationId).toBe(input.rememberedSpaceId)
  await expect(
    setActiveRecordSpace(input.actorUrl, signedIn.token, input.outsiderSpaceId),
  ).rejects.toThrow('is not a member of space')
}

/**
 * The active-space proofs. They live here rather than inline so the RLS suite
 * stays under its file ceiling, following the invitation proofs' registrar.
 */
export function registerActiveSpaceProofs(input: {
  actorUrl: () => string
  tokenB: () => string
  spaceB: () => string
  rememberedSpaceId: () => string
  outsiderSpaceId: string
  password: string
  executeAsOwner: (sql: string) => string
  setToken: (token: string) => void
  memberships: (url: string) => Promise<{
    activeSpaceId: string | null
    memberships: { spaceId: string; slug: string }[]
  }>
  switchSpace: (url: string, slug: string) => Promise<{ spaceId: string }>
}) {
  test('space list and switch repair a session with no active space', async () => {
    input.executeAsOwner(`UPDATE session SET active_space_id=NULL WHERE token='${input.tokenB()}';`)
    input.setToken(input.tokenB())
    const listed = await input.memberships(input.actorUrl())
    expect(listed.activeSpaceId).toBeNull()
    expect(listed.memberships.map((row) => row.spaceId)).toEqual([input.spaceB()])
    expect((await input.switchSpace(input.actorUrl(), listed.memberships[0]!.slug)).spaceId).toBe(
      input.spaceB(),
    )
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
