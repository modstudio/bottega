import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { identity } from '../../test/fixtures/record-api.ts'
import { registerRecordInvitationRoute } from './record-api-invitations.ts'

test('the invitations route derives its user and email from the authenticated identity', async () => {
  const calls: Array<{ url: string; userId: string; email: string }> = []
  const app = new Hono<{ Variables: { identity: typeof identity } }>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', identity)
    await next()
  })
  registerRecordInvitationRoute(app, {
    recordUrl: 'postgres://record.test/record',
    listInvitations: async (input) => {
      calls.push(input)
      return []
    },
  })
  expect((await app.request('/v1/invitations')).status).toBe(200)
  expect(calls).toEqual([
    {
      url: 'postgres://record.test/record',
      userId: identity.user.id,
      email: String(identity.user.email),
    },
  ])
})
