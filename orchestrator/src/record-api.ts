// concern: record-api
/** Owns the hosted JSON surface. Must not know SQL, local execution, or deployment. */
import { Hono } from 'hono'
import { z } from 'zod'
import { RECORD_SIGN_IN_REMEDY, type RecordIdentity } from './record-auth.ts'
import type { RecordRun } from './record-runs.ts'

type AuthHandler = { handler(request: Request): Response | Promise<Response> }
type RecordApiEnvironment = { Variables: { identity: RecordIdentity } }
type RecordApiDeps = {
  recordUrl: string
  auth: AuthHandler
  readSession(headers: Headers): Promise<RecordIdentity | null>
  readHealth(): Promise<{ ok: boolean; migrations: number }>
  readRuns(input: {
    url: string
    userId: string
    spaceId: string
    limit: number
  }): Promise<RecordRun[]>
}

const limitSchema = z.coerce.number().int().min(1).max(100).default(20)
const activeSpaceRemedy = 'run `orch record space` to select an active space'

export function recordApi(deps: RecordApiDeps): Hono<RecordApiEnvironment> {
  const app = new Hono<RecordApiEnvironment>()

  app.get('/health', async (context) => {
    const health = await deps.readHealth()
    return context.json(health, health.ok ? 200 : 503)
  })

  app.all('/api/auth/*', (context) => deps.auth.handler(context.req.raw))

  app.use('/v1/*', async (context, next) => {
    const identity = await deps.readSession(context.req.raw.headers)
    if (!identity) {
      return context.json(
        { error: 'record authentication required', remedy: RECORD_SIGN_IN_REMEDY },
        401,
      )
    }
    context.set('identity', identity)
    await next()
  })

  app.get('/v1/whoami', (context) => {
    const identity = context.get('identity')
    if (!identity.activeSpaceId) {
      return context.json(
        { error: 'record session has no active space', remedy: activeSpaceRemedy },
        409,
      )
    }
    return context.json(identity)
  })

  app.get('/v1/runs', async (context) => {
    const identity = context.get('identity')
    if (!identity.activeSpaceId) {
      return context.json(
        { error: 'record session has no active space', remedy: activeSpaceRemedy },
        409,
      )
    }
    const parsed = limitSchema.safeParse(context.req.query('limit'))
    if (!parsed.success) {
      return context.json({ error: 'limit must be an integer from 1 through 100' }, 400)
    }
    return context.json(
      await deps.readRuns({
        url: deps.recordUrl,
        userId: identity.user.id,
        spaceId: identity.activeSpaceId,
        limit: parsed.data,
      }),
    )
  })

  return app
}
