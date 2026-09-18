// concern: record-api
/** Owns the hosted JSON surface. Must not know SQL, local execution, or deployment. */

import type { Context } from 'hono'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import { RECORD_SIGN_IN_REMEDY, type RecordIdentity } from './record-auth.ts'
import type { RecordDoc, RecordDocImportInput, RecordDocRevision } from './record-docs.ts'
import { RecordDocError } from './record-docs.ts'
import type { RecordProject } from './record-projects.ts'
import type { RecordCursor, RecordRun, RecordRunDetail } from './record-runs.ts'
import type { RecordSnapshot, SnapshotKind } from './record-snapshots.ts'
import { SNAPSHOT_KINDS } from './record-snapshots.ts'
import type { RecordScore } from './record-verdicts.ts'
import { RecordVerdictError } from './record-verdicts.ts'

export const SNAPSHOT_MAX_BYTES = 1024 * 1024

type AuthHandler = { handler(request: Request): Response | Promise<Response> }
type ApiEnvironment = { Variables: { identity: RecordIdentity } }
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
type Deps = {
  recordUrl: string
  allowedOrigins?: string[]
  auth: AuthHandler
  readSession(headers: Headers): Promise<RecordIdentity | null>
  readHealth(): Promise<{ ok: boolean; migrations: number }>
  setActiveSpace(headers: Headers, spaceId: string): Promise<void>
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
  listDocs(
    input: Tenant & {
      scope?: string
      subject?: string | null
      updatedSince?: string
      limit: number
      cursor: RecordCursor | null
      includeDeleted: boolean
    },
  ): Promise<RecordDoc[]>
  readDoc(input: Tenant & { id: string }): Promise<RecordDoc | null>
  listDocRevisions(input: Tenant & { id: string }): Promise<RecordDocRevision[] | null>
  upsertDoc(
    input: Tenant & {
      scope: string
      subject: string | null
      slug: string
      title: string
      body: string
      delivery: 'inject' | 'demand'
      projectName?: string | null
      reason: string
      author: string
      forceInject?: string
      op?: RecordDocRevision['op']
      at?: string
      id?: string
      revisionId?: string
    },
  ): Promise<{ id: string; revisionId: string }>
  importDoc(input: Tenant & RecordDocImportInput): Promise<{ id: string; revisionIds: string[] }>
  deleteDoc(
    input: Tenant & { id: string; reason: string; author: string },
  ): Promise<{ id: string; revisionId: string }>
  consumeDoc(
    input: Tenant & { id: string; reason: string; author: string },
  ): Promise<{ id: string; revisionId: string; alreadyConsumed: boolean }>
  restoreDoc(
    input: Tenant & { id: string; revisionId: string; reason: string; author: string },
  ): Promise<{ id: string; revisionId: string }>
  renameDocSubject(
    input: Tenant & { from: string; to: string; count: number },
  ): Promise<{ docs: number; revisions: number }>
  countDocs(input: Tenant): Promise<{ docs: number; revisions: number }>
  upsertScore(
    input: Tenant & {
      id: string
      delivery: string
      quality: string | null
      fidelity: string | null
      note: string | null
      scoredAt: string
      scoredBy: string
    },
  ): Promise<void>
  voidRun(input: Tenant & { id: string; reason: string }): Promise<void>
  listScores(
    input: Tenant & { updatedSince?: string; limit: number; cursor: RecordCursor | null },
  ): Promise<RecordScore[]>
  countScores(input: Tenant): Promise<{ scores: number; voids: number }>
  upsertSnapshot(
    input: Tenant & { kind: SnapshotKind; machineId: string; payload: unknown },
  ): Promise<{ takenAt: string }>
  listSnapshots(input: Tenant): Promise<RecordSnapshot[]>
}

const limitSchema = z.coerce.number().int().min(1).max(100).default(20)
const filterSchema = z.string().min(1).optional()
const idSchema = z.string().uuid()
const isoSchema = z.string().datetime({ offset: true })
const cursorSchema = z.object({ at: isoSchema, id: z.string().uuid() })
const deliverySchema = z.enum(['inject', 'demand'])
const snapshotKindSchema = z.enum(SNAPSHOT_KINDS)
const revisionOpSchema = z.enum([
  'create',
  'set',
  'consume',
  'delete',
  'restore',
  'import',
  'backfill',
])
const docImportSchema = z.object({
  doc: z.object({
    scope: z.string().min(1),
    subject: z.string().nullable(),
    slug: z.string().min(1),
    title: z.string(),
    body: z.string(),
    delivery: deliverySchema,
    projectName: z.string().nullable().optional(),
    createdAt: isoSchema,
    updatedAt: isoSchema,
    deletedAt: isoSchema.nullable(),
  }),
  revisions: z.array(
    z.object({
      scope: z.string().min(1),
      subject: z.string().nullable(),
      slug: z.string().min(1),
      op: revisionOpSchema,
      title: z.string(),
      body: z.string(),
      delivery: deliverySchema,
      author: z.string().trim().min(1),
      reason: z.string().trim().min(1),
      sessionId: z.string().nullable().optional(),
      at: isoSchema,
    }),
  ),
})
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
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    }
    app.use('/v1/*', cors(options))
    app.use('/api/auth/*', cors(options))
  }
  app.get('/health', async (context) => {
    const health = await deps.readHealth()
    return context.json(health, health.ok ? 200 : 503)
  })
  app.all('/api/auth/*', async (context) => {
    const response = await deps.auth.handler(context.req.raw)
    // A reset request never reveals whether mail was sent or the client-IP limit was reached.
    if (context.req.path === '/api/auth/request-password-reset' && response.status === 429) {
      return context.json({
        status: true,
        message: 'If this email exists in our system, check your email for the reset link',
      })
    }
    return response
  })
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
    return context.json(context.get('identity'))
  })
  app.put('/v1/active-space', async (context) => {
    const input = z
      .object({ spaceId: idSchema })
      .safeParse(await context.req.json().catch(() => null))
    if (!input.success) return context.json({ error: 'active space id must be a uuid' }, 400)
    try {
      await deps.setActiveSpace(context.req.raw.headers, input.data.spaceId)
      return context.json({ activeSpaceId: input.data.spaceId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('is not a member of space')) return context.json({ error: message }, 403)
      throw error
    }
  })
  const scope = (context: Context<ApiEnvironment>): Tenant | null => {
    const identity = context.get('identity') as RecordIdentity
    if (!identity.activeSpaceId) return null
    const memberships = identity.memberships.map((row) => String(row.space_id))
    return {
      url: deps.recordUrl,
      userId: identity.user.id,
      spaceId: identity.activeSpaceId,
      spaceIds:
        identity.activeSpaceId === identity.personalSpaceId
          ? memberships
          : [identity.activeSpaceId],
    }
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
  const writeError = (context: Context<ApiEnvironment>, error: unknown) => {
    if (error instanceof RecordDocError || error instanceof RecordVerdictError) {
      return context.json({ error: error.message }, error.status)
    }
    throw error
  }
  const page = <T>(items: T[], limit: number, cursorOf: (item: T) => RecordCursor) => {
    const hasMore = items.length > limit
    if (hasMore) items.pop()
    const last = items.at(-1)
    return { items, nextCursor: hasMore && last ? encodeRecordCursor(cursorOf(last)) : null }
  }
  app.get('/v1/docs', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const query = z
      .object({
        scope: filterSchema,
        subject: z.string().optional(),
        updatedSince: z.string().datetime({ offset: true }).optional(),
        limit: limitSchema,
        cursor: z.string().optional(),
        includeDeleted: z
          .enum(['true', 'false'])
          .optional()
          .transform((value) => value === 'true'),
      })
      .safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid doc list query' }, 400)
    let cursor: RecordCursor | null = null
    try {
      cursor = query.data.cursor ? decodeRecordCursor(query.data.cursor) : null
    } catch {
      return context.json({ error: 'invalid cursor' }, 400)
    }
    const items = await deps.listDocs({
      ...tenant,
      scope: query.data.scope,
      subject: query.data.subject === undefined ? undefined : query.data.subject || null,
      updatedSince: query.data.updatedSince,
      limit: query.data.limit,
      cursor,
      includeDeleted: Boolean(query.data.includeDeleted),
    })
    return context.json(
      page(items, query.data.limit, (item) => ({ at: item.updatedAt, id: item.id })),
    )
  })
  app.get('/v1/docs/counts', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const docs = await deps.countDocs(tenant)
    const scores = await deps.countScores(tenant)
    return context.json({ ...docs, ...scores })
  })
  app.get('/v1/docs/:id', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) return context.json({ error: 'doc id must be a uuid' }, 400)
    const doc = await deps.readDoc({ ...tenant, id: id.data })
    return doc ? context.json(doc) : context.json({ error: 'doc not found' }, 404)
  })
  app.get('/v1/docs/:id/revisions', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) return context.json({ error: 'doc id must be a uuid' }, 400)
    const items = await deps.listDocRevisions({ ...tenant, id: id.data })
    return items ? context.json({ items }) : context.json({ error: 'doc not found' }, 404)
  })
  app.put('/v1/docs', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const body = z
      .object({
        scope: z.string().min(1),
        subject: z.string().nullable(),
        slug: z.string().min(1),
        title: z.string(),
        body: z.string(),
        delivery: deliverySchema,
        projectName: z.string().nullable().optional(),
        reason: z.string().trim().min(1),
        author: z.string().trim().min(1),
        forceInject: z.string().min(1).optional(),
        op: revisionOpSchema.optional(),
        at: isoSchema.optional(),
        id: z.string().uuid().optional(),
        revisionId: z.string().uuid().optional(),
      })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid doc upsert' }, 400)
    try {
      return context.json(await deps.upsertDoc({ ...tenant, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/docs/import', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const body = docImportSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid doc import' }, 400)
    try {
      return context.json(await deps.importDoc({ ...tenant, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.delete('/v1/docs/:id', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) return context.json({ error: 'doc id must be a uuid' }, 400)
    const body = z
      .object({ reason: z.string().trim().min(1), author: z.string().trim().min(1) })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid doc delete' }, 400)
    try {
      return context.json(await deps.deleteDoc({ ...tenant, id: id.data, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/docs/:id/consume', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) return context.json({ error: 'doc id must be a uuid' }, 400)
    const body = z
      .object({ reason: z.string().trim().min(1), author: z.string().trim().min(1) })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid doc consume' }, 400)
    try {
      return context.json(await deps.consumeDoc({ ...tenant, id: id.data, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/docs/:id/restore', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) return context.json({ error: 'doc id must be a uuid' }, 400)
    const body = z
      .object({
        revisionId: z.string().uuid(),
        reason: z.string().trim().min(1),
        author: z.string().trim().min(1),
      })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid doc restore' }, 400)
    try {
      return context.json(await deps.restoreDoc({ ...tenant, id: id.data, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/docs/rename-subject', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const body = z
      .object({
        from: z.string().min(1),
        to: z.string().min(1),
        count: z.number().int().nonnegative(),
      })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid subject rename' }, 400)
    try {
      return context.json(await deps.renameDocSubject({ ...tenant, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.get('/v1/scores', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const query = z
      .object({
        updatedSince: z.string().datetime({ offset: true }).optional(),
        limit: limitSchema,
        cursor: z.string().optional(),
      })
      .safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid score list query' }, 400)
    let cursor: RecordCursor | null = null
    try {
      cursor = query.data.cursor ? decodeRecordCursor(query.data.cursor) : null
    } catch {
      return context.json({ error: 'invalid cursor' }, 400)
    }
    const items = await deps.listScores({
      ...tenant,
      updatedSince: query.data.updatedSince,
      limit: query.data.limit,
      cursor,
    })
    return context.json(
      page(items, query.data.limit, (item) => ({ at: item.updatedAt, id: item.runId })),
    )
  })
  app.put('/v1/runs/:id/score', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) return context.json({ error: 'run id must be a uuid' }, 400)
    const body = z
      .object({
        delivery: z.string(),
        quality: z.string().nullable(),
        fidelity: z.string().nullable(),
        note: z.string().nullable(),
        scoredAt: z.string().datetime({ offset: true }),
        scoredBy: z.string().min(1),
      })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid score upsert' }, 400)
    try {
      await deps.upsertScore({ ...tenant, id: id.data, ...body.data })
      return context.json({ ok: true })
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/runs/:id/void', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) return context.json({ error: 'run id must be a uuid' }, 400)
    const body = z
      .object({ reason: z.string().min(1).default('voided with orch score --void') })
      .safeParse(await context.req.json().catch(() => ({})))
    if (!body.success) return context.json({ error: 'invalid void' }, 400)
    try {
      await deps.voidRun({ ...tenant, id: id.data, reason: body.data.reason })
      return context.json({ ok: true })
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.put('/v1/snapshots/:kind', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const kind = snapshotKindSchema.safeParse(context.req.param('kind'))
    if (!kind.success) return context.json({ error: 'invalid snapshot kind' }, 400)
    const body = z
      .object({ machineId: z.string().uuid(), payload: z.json() })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid snapshot' }, 400)
    const bytes = new TextEncoder().encode(JSON.stringify(body.data.payload)).byteLength
    if (bytes > SNAPSHOT_MAX_BYTES) {
      return context.json({ error: `snapshot payload exceeds ${SNAPSHOT_MAX_BYTES} bytes` }, 413)
    }
    return context.json(await deps.upsertSnapshot({ ...tenant, kind: kind.data, ...body.data }))
  })
  app.get('/v1/snapshots', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    return context.json({ items: await deps.listSnapshots(tenant) })
  })
  return app
}
