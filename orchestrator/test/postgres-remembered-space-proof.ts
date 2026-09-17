import { expect } from 'bun:test'
import { newRecordId } from '../../shared/record/schema.ts'
import { bearerHeaders, recordAuth, setActiveRecordSpace } from '../src/record/record-auth.ts'

export async function proveRememberedSpace(input: {
  actorUrl: string
  rememberedSpaceId: string
  outsiderSpaceId: string
  password: string
  executeAsOwner: (sql: string) => string
}) {
  const email = 'auth-remembered@example.test'
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
