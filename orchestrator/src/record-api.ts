// concern: record-api
/** Owns the hosted JSON surface. Must not know SQL, local execution, or deployment. */

import type { Context } from 'hono'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import { RECORD_SIGN_IN_REMEDY, type RecordIdentity } from './record-auth.ts'
import type { RecordProject } from './record-projects.ts'
import type { RecordCursor, RecordRun, RecordRunDetail } from './record-runs.ts'

type AuthHandler = { handler(request: Request): Response | Promise<Response> }
type ApiEnvironment = { Variables: { identity: RecordIdentity } }
type Tenant = { url: string; userId: string; spaceId: string }
type Deps = {
  recordUrl: string
  allowedOrigins?: string[]
  auth: AuthHandler
  readSession(headers: Headers): Promise<RecordIdentity | null>
  readHealth(): Promise<{ ok: boolean; migrations: number }>
  readRuns(
    input: Tenant & {
      limit: number
      before: RecordCursor | null
      project?: string
      agent?: string
      job?: string
      status?: string
    },
  ): Promise<RecordRun[]>
  readRun(input: Tenant & { id: string }): Promise<RecordRunDetail | null>
  readReviews(
    input: Tenant & { limit: number; before: RecordCursor | null },
  ): Promise<Record<string, unknown>[]>
  readReview(input: Tenant & { id: string }): Promise<Record<string, unknown> | null>
  readProjects(input: Tenant): Promise<RecordProject[]>
}

const limitSchema = z.coerce.number().int().min(1).max(100).default(20)
const filterSchema = z.string().min(1).optional()
const idSchema = z.string().uuid()
const cursorSchema = z.object({ at: z.string().datetime({ offset: true }), id: z.string().uuid() })
const activeSpaceRemedy = 'run `orch record space switch <slug>` to select an active space'

export const encodeRecordCursor = (cursor: RecordCursor) => btoa(JSON.stringify(cursor))
export const decodeRecordCursor = (value: string): RecordCursor =>
  cursorSchema.parse(JSON.parse(atob(value)))
const noSpace = (context: Context<ApiEnvironment>) =>
  context.json({ error: 'record session has no active space', remedy: activeSpaceRemedy }, 409)

export function recordApi(deps: Deps): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>()
  if (deps.allowedOrigins?.length) {
    const allowed = new Set(deps.allowedOrigins)
    const options = {
      origin: (origin: string) => (allowed.has(origin) ? origin : undefined),
      credentials: true,
      allowHeaders: ['Authorization', 'Content-Type'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
    }
    app.use('/v1/*', cors(options))
    app.use('/api/auth/*', cors(options))
  }
  app.get('/health', async (context) => {
    const health = await deps.readHealth()
    return context.json(health, health.ok ? 200 : 503)
  })
  app.all('/api/auth/*', (context) => deps.auth.handler(context.req.raw))
  app.use('/v1/*', async (context, next) => {
    const identity = await deps.readSession(context.req.raw.headers)
    if (!identity)
      return context.json(
        { error: 'record authentication required', remedy: RECORD_SIGN_IN_REMEDY },
        401,
      )
    context.set('identity', identity)
    await next()
  })
  app.get('/v1/whoami', (context) => {
    const identity = context.get('identity')
    return identity.activeSpaceId ? context.json(identity) : noSpace(context)
  })
  const scope = (context: Context<ApiEnvironment>): Tenant | null => {
    const identity = context.get('identity') as RecordIdentity
    return identity.activeSpaceId
      ? { url: deps.recordUrl, userId: identity.user.id, spaceId: identity.activeSpaceId }
      : null
  }
  app.get('/v1/runs', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const query = z
      .object({
        limit: limitSchema,
        before: z.string().optional(),
        project: filterSchema,
        agent: filterSchema,
        job: filterSchema,
        status: filterSchema,
      })
      .safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid run list query' }, 400)
    let before: RecordCursor | null = null
    try {
      before = query.data.before ? decodeRecordCursor(query.data.before) : null
    } catch {
      return context.json({ error: 'invalid before cursor' }, 400)
    }
    const items = await deps.readRuns({ ...tenant, ...query.data, before })
    const hasMore = items.length > query.data.limit
    if (hasMore) items.pop()
    const last = items.at(-1)
    return context.json({
      items,
      nextCursor: hasMore && last ? encodeRecordCursor({ at: last.startedAt, id: last.id }) : null,
    })
  })
  app.get('/v1/runs/:id', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) return context.json({ error: 'run id must be a uuid' }, 400)
    const run = await deps.readRun({ ...tenant, id: id.data })
    return run ? context.json(run) : context.json({ error: 'run not found' }, 404)
  })
  app.get('/v1/reviews', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const query = z
      .object({ limit: limitSchema, before: z.string().optional() })
      .safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid review list query' }, 400)
    let before: RecordCursor | null = null
    try {
      before = query.data.before ? decodeRecordCursor(query.data.before) : null
    } catch {
      return context.json({ error: 'invalid before cursor' }, 400)
    }
    const items = await deps.readReviews({ ...tenant, limit: query.data.limit, before })
    const hasMore = items.length > query.data.limit
    if (hasMore) items.pop()
    const last = items.at(-1)
    return context.json({
      items,
      nextCursor:
        hasMore && last
          ? encodeRecordCursor({ at: String(last.recordedAt), id: String(last.id) })
          : null,
    })
  })
  app.get('/v1/reviews/:id', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) return context.json({ error: 'review id must be a uuid' }, 400)
    const review = await deps.readReview({ ...tenant, id: id.data })
    return review ? context.json(review) : context.json({ error: 'review not found' }, 404)
  })
  app.get('/v1/projects', async (context) => {
    const tenant = scope(context)
    return tenant ? context.json(await deps.readProjects(tenant)) : noSpace(context)
  })
  return app
}
