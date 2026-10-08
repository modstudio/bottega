// concern: record-api
/** Owns the hosted JSON surface. Must not know SQL, local execution, or deployment. */

import type { Context } from 'hono'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import { DOC_AUDIENCES, DOC_KINDS, DOC_STATUSES } from '../../../shared/docs.ts'
import { VERDICT_INPUT_SCHEMA, type VerdictInput } from '../verdict/verdict-payload.ts'
import { VOID_EXCLUSION_REASON } from '../verdict/verdict-rules.ts'
import { registerRecordAccessRoutes } from './record-api-access.ts'
import { type RecordBoardDeps, registerRecordBoardRoutes } from './record-api-board.ts'
import {
  recordCanonImportSchema,
  recordDocImportSchema,
  recordDocUpsertSchema,
} from './record-api-doc-schemas.ts'
import { registerRecordProjectRoutes } from './record-api-projects.ts'
import { registerPublicDocRoutes, registerSignedDocSearchRoute } from './record-api-public-docs.ts'
import { registerRecordRequestSpace } from './record-api-request-space.ts'
import { registerRecordSettingsRoutes } from './record-api-settings.ts'
import { RECORD_SIGN_IN_REMEDY, type RecordIdentity } from './record-auth.ts'
import { RecordBoardError } from './record-board-contract.ts'
import type {
  ConfigEntry,
  ConfigScope,
  ConfigSecret,
  ConfigSecretMetadata,
  ConfigWrapInput,
  DataKey,
  MachineKey,
} from './record-config.ts'
import { CONFIG_SCOPES, ConfigServiceError, MACHINE_KEY_ID_PATTERN } from './record-config.ts'
import {
  type RecordCanonImportInput,
  type RecordCanonImportResult,
  type RecordDoc,
  RecordDocError,
  type RecordDocImportInput,
  type RecordDocListInput,
  type RecordDocRevision,
} from './record-docs.ts'
import {
  type RecordProject,
  RecordProjectError,
  type RecordProjectUpsertInput,
} from './record-projects.ts'
import type {
  PublicRecordDoc,
  PublicRecordDocTreeItem,
  RecordDocSearchInput,
  RecordDocSearchMatch,
} from './record-public-docs.ts'
import type {
  RecordCursor,
  RecordRun,
  RecordRunDetail,
  RecordRunsWindow,
  RecordRunsWindowInput,
} from './record-runs.ts'
import { runsWindowQuery } from './record-runs-window-query.ts'
import type {
  RecordSettingsPermissionInput,
  RecordSettingsPermissionResult,
} from './record-settings.ts'
import { type RecordSnapshot, SNAPSHOT_KINDS, type SnapshotKind } from './record-snapshots.ts'
import type { RecordScore } from './record-verdicts.ts'
import { RecordVerdictError } from './record-verdicts.ts'

export const SNAPSHOT_MAX_BYTES = 1024 * 1024

type ApiEnvironment = {
  Variables: { identity: RecordIdentity; destinationSpaceId?: string }
}
type Tenant = { url: string; userId: string; spaceId: string; spaceIds: string[] }
type Deps = {
  recordUrl: string
  allowedOrigins?: string[]
  auth: { handler(request: Request): Response | Promise<Response> }
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
  readRunsWindow(
    input: Tenant & Omit<RecordRunsWindowInput, keyof Tenant>,
  ): Promise<RecordRunsWindow>
  readRun(input: Tenant & { id: string }): Promise<RecordRunDetail | null>
  readReviews(
    input: Tenant & { limit: number; before: RecordCursor | null },
  ): Promise<Record<string, unknown>[]>
  readReview(input: Tenant & { id: string }): Promise<Record<string, unknown> | null>
  readProjects(input: Tenant): Promise<RecordProject[]>
  upsertProject(input: Tenant & RecordProjectUpsertInput): Promise<{ name: string }>
  retireProject(input: Tenant & { name: string }): Promise<{ name: string }>
  listDocs(input: Tenant & RecordDocListInput): Promise<RecordDoc[]>
  listPublicDocs(input: { url: string }): Promise<PublicRecordDocTreeItem[]>
  readPublicDoc(input: { url: string; id: string }): Promise<PublicRecordDoc | null>
  searchPublicDocs(input: { url: string; query: string }): Promise<RecordDocSearchMatch[]>
  searchDocs(input: Tenant & RecordDocSearchInput): Promise<RecordDocSearchMatch[]>
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
      expectedRevision?: string
    },
  ): Promise<{ id: string; revisionId: string }>
  importDoc(input: Tenant & RecordDocImportInput): Promise<{ id: string; revisionIds: string[] }>
  importCanon(input: Tenant & RecordCanonImportInput): Promise<RecordCanonImportResult>
  deleteDoc(
    input: Tenant & { id: string; reason: string; author: string; expectedRevision?: string },
  ): Promise<{ id: string; revisionId: string }>
  consumeDoc(
    input: Tenant & { id: string; reason: string; author: string; expectedRevision?: string },
  ): Promise<{ id: string; revisionId: string; alreadyConsumed: boolean }>
  restoreDoc(
    input: Tenant & {
      id: string
      revisionId: string
      reason: string
      author: string
      expectedRevision?: string
    },
  ): Promise<{ id: string; revisionId: string }>
  renameDocSubject(
    input: Tenant & { from: string; to: string; count: number },
  ): Promise<{ docs: number; revisions: number }>
  countDocs(input: Tenant): Promise<{ docs: number; revisions: number }>
  applySettingsPermission(
    input: RecordSettingsPermissionInput,
  ): Promise<RecordSettingsPermissionResult>
  upsertScore(
    input: Tenant &
      Omit<VerdictInput, 'scoredBy'> & {
        id: string
        scoredBy: string
      },
  ): Promise<void>
  voidRun(input: Tenant & { id: string; reason: string }): Promise<void>
  unvoidRun(input: Tenant & { id: string; note: string }): Promise<void>
  listScores(
    input: Tenant & {
      updatedSince?: string
      limit: number
      cursor: RecordCursor | null
    },
  ): Promise<RecordScore[]>
  countScores(input: Tenant): Promise<{ scores: number; voids: number }>
  upsertSnapshot(
    input: Tenant & { kind: SnapshotKind; machineId: string; payload: unknown },
  ): Promise<{ takenAt: string }>
  listSnapshots(input: Tenant): Promise<RecordSnapshot[]>
  listConfigEntries(input: Tenant & { environment?: string }): Promise<ConfigEntry[]>
  getConfigEntry(
    input: Tenant & { key: string; environment: string; scope: ConfigScope },
  ): Promise<ConfigEntry | null>
  putConfigEntry(
    input: Tenant & {
      key: string
      environment: string
      scope: ConfigScope
      value: string
      expectedRowVersion: number | null
    },
  ): Promise<ConfigEntry>
  deleteConfigEntry(
    input: Tenant & {
      key: string
      environment: string
      scope: ConfigScope
      expectedRowVersion: number
    },
  ): Promise<void>
  listConfigSecrets(input: Tenant & { environment?: string }): Promise<ConfigSecretMetadata[]>
  getConfigSecret(
    input: Tenant & { key: string; environment: string; scope: ConfigScope },
  ): Promise<ConfigSecret | null>
  putConfigSecret(
    input: Tenant & {
      key: string
      environment: string
      scope: ConfigScope
      dekId: string
      envelope: Uint8Array
      expectedRowVersion: number | null
    },
  ): Promise<ConfigSecretMetadata>
  deleteConfigSecret(
    input: Tenant & {
      key: string
      environment: string
      scope: ConfigScope
      expectedRowVersion: number
    },
  ): Promise<void>
  currentDataKey(input: Tenant & { recipientKeyId: string }): Promise<DataKey | null>
  listDataKeys(input: Tenant): Promise<DataKey[]>
  getDataKey(input: Tenant & { dekId: string; recipientKeyId: string }): Promise<DataKey | null>
  createDataKey(
    input: Tenant & { dekId: string; version: number; wraps: ConfigWrapInput[] },
  ): Promise<{ id: string; version: number }>
  addDataKeyWraps(input: Tenant & { dekId: string; wraps: ConfigWrapInput[] }): Promise<void>
  retireDataKey(input: Tenant & { dekId: string }): Promise<void>
  deleteDataKeyWraps(input: Tenant & { recipientKeyId: string }): Promise<void>
  listMachineKeys(input: Tenant): Promise<MachineKey[]>
  registerMachineKey(
    input: Tenant & { keyId: string; publicKey: Uint8Array; label: string },
  ): Promise<MachineKey>
  revokeMachineKey(input: Tenant & { keyId: string }): Promise<void>
} & RecordBoardDeps

const limitSchema = z.coerce.number().int().min(1).max(100).default(20)
const filterSchema = z.string().min(1).optional()
const idSchema = z.string().uuid()
const isoSchema = z.string().datetime({ offset: true })
const cursorSchema = z.object({ at: isoSchema, id: z.string().uuid() })
const snapshotKindSchema = z.enum(SNAPSHOT_KINDS)
const configScopeSchema = z.enum(CONFIG_SCOPES)
const expectedVersionSchema = z.number().int().positive()
const base64urlSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => Buffer.from(value, 'base64url').toString('base64url') === value)
const keyIdSchema = z.string().regex(MACHINE_KEY_ID_PATTERN)
const wrapSchema = z.object({
  recipientKeyId: keyIdSchema,
  senderKeyId: keyIdSchema,
  enc: base64urlSchema,
  ciphertext: base64urlSchema,
})
const docWriteContextSchema = z.object({
  reason: z.string().trim().min(1),
  author: z.string().trim().min(1),
  expectedRevision: z.string().uuid().optional(),
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
      allowHeaders: ['Authorization', 'Content-Type', 'X-Record-Space'],
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    }
    app.use('/v1/*', cors(options))
    app.use('/public/v1/*', cors(options))
    app.use('/api/auth/*', cors(options))
  }
  registerRecordAccessRoutes(app, deps)
  registerPublicDocRoutes(app, deps)
  app.use('/v1/*', async (context, next) => {
    const identity = await deps.readSession(context.req.raw.headers)
    if (!identity)
      return context.json(
        {
          error: 'record authentication required',
          remedy: RECORD_SIGN_IN_REMEDY,
        },
        401,
      )
    context.set('identity', identity)
    await next()
  })
  app.get('/v1/whoami', (context) => {
    return context.json(context.get('identity'))
  })
  registerRecordRequestSpace(app)
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
    const destinationSpaceId = context.get('destinationSpaceId')
    return {
      url: deps.recordUrl,
      userId: identity.user.id,
      spaceId: destinationSpaceId ?? identity.activeSpaceId,
      spaceIds:
        destinationSpaceId || identity.activeSpaceId === identity.personalSpaceId
          ? memberships
          : [identity.activeSpaceId],
    }
  }
  registerSignedDocSearchRoute(app, deps, { scope, noSpace })
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
  app.get('/v1/runs/window', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const query = runsWindowQuery.safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid run window query' }, 400)
    return context.json(await deps.readRunsWindow({ ...tenant, ...query.data }))
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
    const items = await deps.readReviews({
      ...tenant,
      limit: query.data.limit,
      before,
    })
    const hasMore = items.length > query.data.limit
    if (hasMore) items.pop()
    const last = items.at(-1)
    return context.json({
      items,
      nextCursor:
        hasMore && last
          ? encodeRecordCursor({
              at: String(last.recordedAt),
              id: String(last.id),
            })
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
  const writeError = (context: Context<ApiEnvironment>, error: unknown) => {
    if (
      error instanceof RecordDocError ||
      error instanceof RecordVerdictError ||
      error instanceof ConfigServiceError ||
      error instanceof RecordProjectError ||
      error instanceof RecordBoardError
    ) {
      return context.json({ error: error.message }, error.status)
    }
    throw error
  }
  registerRecordProjectRoutes(app, deps, { scope, noSpace, writeError })
  registerRecordSettingsRoutes(app, deps, { scope, noSpace, writeError })
  registerRecordBoardRoutes(app, deps, { noSpace, writeError })
  const encoded = (value: Uint8Array) => Buffer.from(value).toString('base64url')
  const decoded = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'))
  const jsonWrap = (wrap: ConfigWrapInput) => ({
    ...wrap,
    enc: encoded(wrap.enc),
    ciphertext: encoded(wrap.ciphertext),
  })
  const inputWrap = (wrap: z.infer<typeof wrapSchema>): ConfigWrapInput => ({
    ...wrap,
    enc: decoded(wrap.enc),
    ciphertext: decoded(wrap.ciphertext),
  })
  const configAddress = z.object({
    environment: z.string().min(1),
    scope: configScopeSchema,
  })
  const configList = z.object({ environment: z.string().min(1).optional() })
  const configBody = z.object({
    environment: z.string().min(1),
    scope: configScopeSchema,
    expectedRowVersion: expectedVersionSchema.nullable(),
  })

  app.get('/v1/config/entries', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const query = configList.safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid config entry list query' }, 422)
    return context.json({
      items: await deps.listConfigEntries({ ...active, ...query.data }),
    })
  })
  app.get('/v1/config/entries/:key', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const query = configAddress.safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid config entry address' }, 422)
    const item = await deps.getConfigEntry({
      ...active,
      key: context.req.param('key'),
      ...query.data,
    })
    return item ? context.json(item) : context.json({ error: 'config entry not found' }, 404)
  })
  app.put('/v1/config/entries/:key', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const body = configBody
      .extend({ value: z.string() })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid config entry body' }, 422)
    try {
      return context.json(
        await deps.putConfigEntry({
          ...active,
          key: context.req.param('key'),
          ...body.data,
        }),
      )
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.delete('/v1/config/entries/:key', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const body = configBody
      .omit({ expectedRowVersion: true })
      .extend({ expectedRowVersion: expectedVersionSchema })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid config entry delete body' }, 422)
    try {
      await deps.deleteConfigEntry({
        ...active,
        key: context.req.param('key'),
        ...body.data,
      })
      return context.json({ deleted: true })
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.get('/v1/config/secrets', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const query = configList.safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid config secret list query' }, 422)
    return context.json({
      items: await deps.listConfigSecrets({ ...active, ...query.data }),
    })
  })
  app.get('/v1/config/secrets/:key', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const query = configAddress.safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid config secret address' }, 422)
    const item = await deps.getConfigSecret({
      ...active,
      key: context.req.param('key'),
      ...query.data,
    })
    return item
      ? context.json({ ...item, envelope: encoded(item.envelope) })
      : context.json({ error: 'config secret not found' }, 404)
  })
  /**
   * The envelope must be sealed for the NEW row version: expectedRowVersion + 1 on update,
   * or version 1 on create. The authenticated data binds that authoritative row_version.
   */
  app.put('/v1/config/secrets/:key', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const body = configBody
      .extend({ dekId: idSchema, envelope: base64urlSchema })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid config secret body' }, 422)
    try {
      return context.json(
        await deps.putConfigSecret({
          ...active,
          ...body.data,
          key: context.req.param('key'),
          envelope: decoded(body.data.envelope),
        }),
      )
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.delete('/v1/config/secrets/:key', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const body = configBody
      .omit({ expectedRowVersion: true })
      .extend({ expectedRowVersion: expectedVersionSchema })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid config secret delete body' }, 422)
    try {
      await deps.deleteConfigSecret({
        ...active,
        key: context.req.param('key'),
        ...body.data,
      })
      return context.json({ deleted: true })
    } catch (error) {
      return writeError(context, error)
    }
  })
  // The client identifies its machine key with the recipientKeyId query parameter.
  app.get('/v1/config/data-keys/current', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const query = z.object({ recipientKeyId: keyIdSchema }).safeParse(context.req.query())
    if (!query.success) return context.json({ error: 'invalid recipient key id' }, 422)
    const item = await deps.currentDataKey({ ...active, ...query.data })
    return item
      ? context.json({ ...item, wraps: item.wraps.map(jsonWrap) })
      : context.json({ error: 'data key not found' }, 404)
  })
  app.get('/v1/config/data-keys', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    return context.json({ items: await deps.listDataKeys(active) })
  })
  app.get('/v1/config/data-keys/:dekId', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const dekId = idSchema.safeParse(context.req.param('dekId'))
    const query = z.object({ recipientKeyId: keyIdSchema }).safeParse(context.req.query())
    if (!dekId.success || !query.success)
      return context.json({ error: 'invalid data key address' }, 422)
    const item = await deps.getDataKey({ ...active, dekId: dekId.data, ...query.data })
    return item
      ? context.json({ ...item, wraps: item.wraps.map(jsonWrap) })
      : context.json({ error: 'data key not found' }, 404)
  })
  app.post('/v1/config/data-keys', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const body = z
      .object({
        dekId: idSchema,
        version: z.number().int().positive(),
        wraps: z.array(wrapSchema),
      })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid data key body' }, 422)
    try {
      return context.json(
        await deps.createDataKey({
          ...active,
          dekId: body.data.dekId,
          version: body.data.version,
          wraps: body.data.wraps.map(inputWrap),
        }),
      )
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/config/data-keys/:dekId/wraps', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const dekId = idSchema.safeParse(context.req.param('dekId'))
    const body = z
      .object({ wraps: z.array(wrapSchema) })
      .safeParse(await context.req.json().catch(() => null))
    if (!dekId.success || !body.success)
      return context.json({ error: 'invalid data key wraps' }, 422)
    try {
      await deps.addDataKeyWraps({
        ...active,
        dekId: dekId.data,
        wraps: body.data.wraps.map(inputWrap),
      })
      return context.json({ added: body.data.wraps.length })
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/config/data-keys/:dekId/retire', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const dekId = idSchema.safeParse(context.req.param('dekId'))
    if (!dekId.success) return context.json({ error: 'invalid data key id' }, 422)
    try {
      await deps.retireDataKey({ ...active, dekId: dekId.data })
      return context.json({ retired: true })
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.delete('/v1/config/wraps/:recipientKeyId', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const recipientKeyId = keyIdSchema.safeParse(context.req.param('recipientKeyId'))
    if (!recipientKeyId.success) return context.json({ error: 'invalid recipient key id' }, 422)
    await deps.deleteDataKeyWraps({
      ...active,
      recipientKeyId: recipientKeyId.data,
    })
    return context.json({ deleted: true })
  })
  app.get('/v1/config/machine-keys', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const items = await deps.listMachineKeys(active)
    return context.json({
      items: items.map((item) => ({
        ...item,
        publicKey: encoded(item.publicKey),
      })),
    })
  })
  app.put('/v1/config/machine-keys/:keyId', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const keyId = keyIdSchema.safeParse(context.req.param('keyId'))
    const body = z
      .object({ publicKey: base64urlSchema, label: z.string().trim().min(1) })
      .safeParse(await context.req.json().catch(() => null))
    if (!keyId.success || !body.success)
      return context.json({ error: 'invalid machine key body' }, 422)
    const publicKey = decoded(body.data.publicKey)
    if (publicKey.byteLength !== 32)
      return context.json({ error: 'machine public key must be 32 bytes' }, 422)
    try {
      const item = await deps.registerMachineKey({
        ...active,
        keyId: keyId.data,
        publicKey,
        label: body.data.label,
      })
      return context.json({ ...item, publicKey: encoded(item.publicKey) })
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/config/machine-keys/:keyId/revoke', async (context) => {
    const active = scope(context)
    if (!active) return noSpace(context)
    const keyId = keyIdSchema.safeParse(context.req.param('keyId'))
    if (!keyId.success) return context.json({ error: 'invalid machine key id' }, 422)
    try {
      await deps.revokeMachineKey({ ...active, keyId: keyId.data })
      return context.json({ revoked: true })
    } catch (error) {
      return writeError(context, error)
    }
  })
  const page = <T>(items: T[], limit: number, cursorOf: (item: T) => RecordCursor) => {
    const hasMore = items.length > limit
    if (hasMore) items.pop()
    const last = items.at(-1)
    return {
      items,
      nextCursor: hasMore && last ? encodeRecordCursor(cursorOf(last)) : null,
    }
  }
  app.get('/v1/docs', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const query = z
      .object({
        scope: filterSchema,
        subject: z.string().optional(),
        audience: z.enum(DOC_AUDIENCES).optional(),
        status: z.enum(DOC_STATUSES).optional(),
        kind: z.enum(DOC_KINDS).optional(),
        updatedSince: z.string().datetime({ offset: true }).optional(),
        limit: limitSchema,
        cursor: z.string().optional(),
        includeDeleted: z
          .enum(['true', 'false'])
          .optional()
          .transform((value) => value === 'true'),
        acrossReadableSpaces: z
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
      audience: query.data.audience,
      status: query.data.status,
      kind: query.data.kind,
      updatedSince: query.data.updatedSince,
      limit: query.data.limit,
      cursor,
      includeDeleted: Boolean(query.data.includeDeleted),
      acrossReadableSpaces: Boolean(query.data.acrossReadableSpaces),
    })
    return context.json(
      page(items, query.data.limit, (item) => ({
        at: item.updatedAt,
        id: item.id,
      })),
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
    const body = recordDocUpsertSchema.safeParse(await context.req.json().catch(() => null))
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
    const body = recordDocImportSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid doc import' }, 400)
    try {
      return context.json(await deps.importDoc({ ...tenant, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/docs/canon/import', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const body = recordCanonImportSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid canon import' }, 400)
    try {
      return context.json(await deps.importCanon({ ...tenant, ...body.data }))
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.delete('/v1/docs/:id', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) return context.json({ error: 'doc id must be a uuid' }, 400)
    const body = docWriteContextSchema.safeParse(await context.req.json().catch(() => null))
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
    const body = docWriteContextSchema.safeParse(await context.req.json().catch(() => null))
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
    const body = docWriteContextSchema
      .extend({
        revisionId: z.string().uuid(),
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
      page(items, query.data.limit, (item) => ({
        at: item.updatedAt,
        id: item.runId,
      })),
    )
  })
  app.put('/v1/runs/:id/score', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) return context.json({ error: 'run id must be a uuid' }, 400)
    const body = VERDICT_INPUT_SCHEMA.omit({ scoredBy: true })
      .extend({ scoredBy: z.string().min(1).optional() })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid score upsert' }, 400)
    try {
      await deps.upsertScore({ ...tenant, id: id.data, ...body.data, scoredBy: tenant.userId })
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
      .object({
        reason: z.string().min(1).default(VOID_EXCLUSION_REASON),
      })
      .safeParse(await context.req.json().catch(() => ({})))
    if (!body.success) return context.json({ error: 'invalid void' }, 400)
    try {
      await deps.voidRun({ ...tenant, id: id.data, reason: body.data.reason })
      return context.json({ ok: true })
    } catch (error) {
      return writeError(context, error)
    }
  })
  app.post('/v1/runs/:id/unvoid', async (context) => {
    const tenant = scope(context)
    if (!tenant) return noSpace(context)
    const id = idSchema.safeParse(context.req.param('id'))
    if (!id.success) return context.json({ error: 'run id must be a uuid' }, 400)
    const body = z
      .object({ note: z.string().trim().min(1) })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid unvoid: note is required' }, 400)
    try {
      await deps.unvoidRun({ ...tenant, id: id.data, note: body.data.note })
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
