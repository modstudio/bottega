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

test('read-only members are refused before remaining tenant write routes run', async () => {
  // Production break watched: register request-space authorization only for projects and docs.
  const writes: string[] = []
  const app = new Hono<ApiEnvironment>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', {
      ...identity,
      memberships: identity.memberships.map((membership) => ({
        ...membership,
        permission: 'read',
      })),
    })
    return next()
  })
  registerRecordRequestSpace(app)
  for (const path of [
    '/v1/config/entries/key',
    '/v1/runs/run-id/score',
    '/v1/runs/run-id/void',
    '/v1/runs/run-id/unvoid',
    '/v1/snapshots/state',
  ]) {
    app.all(path, (context) => {
      writes.push(context.req.path)
      return context.json({ ok: true })
    })
  }

  for (const [path, method] of [
    ['/v1/config/entries/key', 'PUT'],
    ['/v1/runs/run-id/score', 'PUT'],
    ['/v1/runs/run-id/void', 'POST'],
    ['/v1/runs/run-id/unvoid', 'POST'],
    ['/v1/snapshots/state', 'PUT'],
  ] as const) {
    const response = await app.request(path, { method })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'record space space-a membership is read-only',
      remedy: 'A space owner or admin can change the membership permission.',
    })
  }
  expect(writes).toEqual([])
})

test('remaining tenant write routes judge and bind the requested destination space', async () => {
  // Production break watched: judge the active space or omit the requested destination binding.
  const destinations: Array<string | undefined> = []
  const app = new Hono<ApiEnvironment>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', {
      ...identity,
      memberships: [
        { ...identity.memberships[0]!, permission: 'read' },
        {
          space_id: 'space-b',
          name: 'Space B',
          slug: 'space-b',
          role: 'member',
          permission: 'write',
        },
      ],
    })
    return next()
  })
  registerRecordRequestSpace(app)
  for (const path of [
    '/v1/config/entries/key',
    '/v1/runs/run-id/score',
    '/v1/runs/run-id/void',
    '/v1/runs/run-id/unvoid',
    '/v1/snapshots/state',
  ]) {
    app.all(path, (context) => {
      destinations.push(context.get('destinationSpaceId'))
      return context.json({ ok: true })
    })
  }

  for (const [path, method] of [
    ['/v1/config/entries/key', 'PUT'],
    ['/v1/runs/run-id/score', 'PUT'],
    ['/v1/runs/run-id/void', 'POST'],
    ['/v1/runs/run-id/unvoid', 'POST'],
    ['/v1/snapshots/state', 'PUT'],
  ] as const) {
    const response = await app.request(path, {
      method,
      headers: { 'x-record-space': 'space-b' },
    })
    expect(response.status).toBe(200)
  }
  expect(destinations).toEqual(Array.from({ length: 5 }, () => 'space-b'))
})
