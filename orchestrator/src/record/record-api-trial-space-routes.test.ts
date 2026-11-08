import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { identity } from '../../test/fixtures/record-api.ts'
import { registerRecordTrialSpaceRoutes } from './record-api-trial-space-routes.ts'

test('the trial-space route derives the caller from identity and accepts the body slug', async () => {
  const calls: unknown[] = []
  const app = new Hono<{ Variables: { identity: typeof identity } }>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', identity)
    await next()
  })
  registerRecordTrialSpaceRoutes(app, {
    recordUrl: 'postgres://record.test/record',
    deleteTrialSpace: async (input) => {
      calls.push(input)
      return {
        nothingToRemove: true,
        activeSpaceCleared: false,
        tables: {},
        neutralized: [],
      }
    },
  })
  const response = await app.request('/v1/spaces/delete-trial', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'trial-route' }),
  })
  expect(response.status).toBe(200)
  expect(calls).toEqual([
    {
      url: 'postgres://record.test/record',
      userId: identity.user.id,
      activeSpaceId: identity.activeSpaceId,
      slug: 'trial-route',
    },
  ])
})

test('the trial-space route refuses a missing slug', async () => {
  const app = new Hono<{ Variables: { identity: typeof identity } }>()
  app.use('/v1/*', async (context, next) => {
    context.set('identity', identity)
    await next()
  })
  registerRecordTrialSpaceRoutes(app, {
    recordUrl: 'postgres://record.test/record',
    deleteTrialSpace: async () => {
      throw new Error('must not be called')
    },
  })
  const response = await app.request('/v1/spaces/delete-trial', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  expect(response.status).toBe(422)
})
