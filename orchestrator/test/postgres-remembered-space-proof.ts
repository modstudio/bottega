import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import {
  bearerHeaders,
  noSpaceBuiltIns,
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
  const auth = recordAuth(
    input.actorUrl,
    process.env,
    undefined,
    undefined,
    undefined,
    noSpaceBuiltIns,
  )
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

async function proveCliSwitchIsRemembered(input: {
  actorUrl: string
  rememberedSpaceId: string
  outsiderSpaceId: string
  password: string
  executeAsOwner: (sql: string) => string
  setToken: (token: string) => void
  memberships: () => Promise<{
    activeSpaceId: string | null
    memberships: { spaceId: string }[]
  }>
  switchSpace: (value: string) => Promise<{ spaceId: string }>
}) {
  const email = 'auth-cli-remembered@example.test'
  input.executeAsOwner(
    `INSERT INTO invitation (id,space_id,email,inviter_id,role,status,expires_at,created_at)
     VALUES ('${newRecordId()}','${input.rememberedSpaceId}','${email}',
       (SELECT id FROM "user" ORDER BY created_at LIMIT 1),'member','pending',
       now() + interval '1 day',now());`,
  )
  const auth = recordAuth(
    input.actorUrl,
    process.env,
    undefined,
    undefined,
    undefined,
    noSpaceBuiltIns,
  )
  const signup = await auth.api.signUpEmail({
    body: { email, name: 'CLI Remembered', password: input.password },
  })
  if (!signup.token) throw new Error('CLI remembered-space signup has no bearer token')
  input.executeAsOwner(
    `INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
     VALUES ('${newRecordId()}','${input.rememberedSpaceId}','${signup.user.id}','member','write',now());`,
  )

  const signedIn = await auth.api.signInEmail({ body: { email, password: input.password } })
  if (!signedIn.token) throw new Error('CLI remembered-space sign-in has no bearer token')
  input.setToken(signedIn.token)
  // A new session defaults to the shared space, so only a switch to the other
  // membership, the personal space, shows that the switch was remembered.
  const listed = await input.memberships()
  expect(listed.activeSpaceId).toBe(input.rememberedSpaceId)
  const personal = listed.memberships.find((row) => row.spaceId !== input.rememberedSpaceId)
  if (!personal) throw new Error('CLI remembered-space user has no personal space')
  expect((await input.switchSpace(personal.spaceId)).spaceId).toBe(personal.spaceId)

  const signedInAgain = await auth.api.signInEmail({ body: { email, password: input.password } })
  if (!signedInAgain.token)
    throw new Error('CLI remembered-space second sign-in has no bearer token')
  input.setToken(signedInAgain.token)
  expect((await input.memberships()).activeSpaceId).toBe(personal.spaceId)

  const beforeRefusal = (await input.memberships()).activeSpaceId
  expect(beforeRefusal).not.toBeNull()
  await expect(input.switchSpace(input.outsiderSpaceId)).rejects.toThrow(
    "is not one of the user's memberships",
  )
  expect((await input.memberships()).activeSpaceId).toBe(beforeRefusal)
}

/**
 * The active-space proofs. They live here rather than inline so the RLS suite
 * stays under its file ceiling, following the invitation proofs' registrar.
 */
export function registerActiveSpaceProofs(input: {
  actorUrl: () => string
  sessionB: () => { token: string; userId: string }
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
    const session = input.sessionB()
    const changed = input.executeAsOwner(`
      WITH changed AS (
        UPDATE session SET active_space_id=NULL WHERE user_id='${session.userId}' RETURNING 1
      )
      SELECT count(*) FROM changed;
    `)
    expect(Number(changed)).toBeGreaterThanOrEqual(1)
    input.setToken(session.token)
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

  test('a CLI space switch survives a new session and refusal preserves the active space', async () => {
    await proveCliSwitchIsRemembered({
      actorUrl: input.actorUrl(),
      rememberedSpaceId: input.rememberedSpaceId(),
      outsiderSpaceId: input.outsiderSpaceId,
      password: input.password,
      executeAsOwner: input.executeAsOwner,
      setToken: input.setToken,
      memberships: input.memberships,
      switchSpace: input.switchSpace,
    })
  })
}
