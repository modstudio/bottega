import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerRecordRequestSpace } from './record-api-request-space.ts'
import type { RecordIdentity } from './record-auth.ts'

type ApiEnvironment = {
  Variables: { identity: RecordIdentity; destinationSpaceId?: string }
}

const identity: RecordIdentity = {
  user: { id: 'user-a', email: 'a@example.test' },
  activeSpaceId: 'space-a',
  personalSpaceId: 'space-a',
  memberships: [
    { space_id: 'space-a', name: 'Space A', slug: 'space-a', role: 'owner', permission: 'write' },
  ],
}

test('project routes refuse an empty requested space before writes', async () => {
  const writes: Array<string | undefined> = []
  const app = new Hono<ApiEnvironment>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', identity)
    return next()
  })
  registerRecordRequestSpace(app)
  app.put('/v1/projects', (context) => {
    writes.push(context.get('destinationSpaceId'))
    return context.json({ ok: true })
  })

  for (const requested of ['', '   ']) {
    const response = await app.request('/v1/projects', {
      method: 'PUT',
      headers: { 'x-record-space': requested },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: expect.stringMatching(/^signed-in user is not a member of record space\s*$/),
      remedy: expect.stringContaining('an invitation from a member of that space is needed'),
    })
  }
  expect(writes).toEqual([])
})
