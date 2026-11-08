import { hostedApiFetch } from '../../shared/bounded-fetch.ts'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import type { RecordSpaceMembership } from '../../shared/record-space-membership.ts'
import {
  recordRequestNature,
  recordSpaceAccessDecision,
} from '../../shared/record-space-request.ts'
import { listHostedNotes } from './hosted-note-list.ts'
import {
  createHostedNote,
  getHostedNote,
  hostedNoteCounts,
  mirrorHostedNotes,
  type PromoteNoteInput,
  promoteHostedNote,
  reapHostedNotes,
} from './hosted-notes.ts'
import {
  HostedOutsideNoteError,
  insertOutsideNote,
  listOutsideNotes,
} from './hosted-outside-notes.ts'
import type { HostedRouteConfig } from './hosted-route-config.ts'
import {
  assertAuthenticatedIdentity,
  identityRefusal,
  taskSpaceIdentity,
} from './hosted-route-identity.ts'
import { HOSTED_PROMOTION_TITLE_REFUSAL, requiredPromotionTitle } from './note-promotion-body.ts'

const TEST_REFUSAL = `${PLATFORM_SLUG} note API refuses real identity and database clients unless stubs are injected in tests`
type Dependencies = { fetch?: typeof fetch; [key: string]: unknown }
type Identity = { userId: string; spaceId: string; memberships: RecordSpaceMembership[] }
type RouteContext = {
  request: Request
  url: URL
  config: HostedRouteConfig
  dependencies: Dependencies
  who: Identity
  body: Record<string, unknown> | null
}
const json = (value: unknown, status = 200) => Response.json(value, { status })
const call = <T>(stub: unknown, real: T): T => {
  if (process.env.NODE_ENV === 'test' && !stub) throw new Error(TEST_REFUSAL)
  return (stub ?? real) as T
}

async function outsideRoute(context: RouteContext): Promise<Response | null> {
  const { request, url, config, dependencies, who, body } = context
  if (url.pathname !== '/v1/notes/outside') return null
  if (request.method === 'GET') {
    const project = url.searchParams.get('project')?.trim()
    if (!project) return json({ error: 'outside note list requires project' }, 400)
    return json(
      await call(dependencies.outsideList, listOutsideNotes)(
        config.recordDatabaseUrl,
        who,
        project,
      ),
    )
  }
  if (request.method === 'POST') {
    const project = typeof body?.project === 'string' ? body.project.trim() : ''
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    const anchor = typeof body?.anchor === 'string' ? body.anchor : ''
    const area = typeof body?.area === 'string' ? body.area.trim() || null : undefined
    if (!project || !text || !anchor)
      return json({ error: 'outside note requires project, text, and anchor' }, 400)
    return json(
      await call(dependencies.outsideCreate, insertOutsideNote)(config.recordDatabaseUrl, who, {
        project,
        text,
        area,
        anchor,
      }),
      201,
    )
  }
  return new Response('not found', { status: 404 })
}

async function readRoute(context: RouteContext): Promise<Response | null> {
  const { request, url, config, dependencies, who } = context
  if (request.method !== 'GET') return null
  if (url.pathname === '/v1/notes')
    return json(
      await call(dependencies.list, listHostedNotes)(config.recordDatabaseUrl, who, {
        project: url.searchParams.get('project') ?? undefined,
        stale: url.searchParams.has('stale') ? url.searchParams.get('stale') === 'true' : undefined,
        actionable: url.searchParams.get('actionable') === 'true',
        updatedSince: url.searchParams.get('updatedSince') ?? undefined,
        cursor: url.searchParams.get('cursor') ?? undefined,
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        includeDeleted: url.searchParams.get('includeDeleted') === 'true',
      }),
    )
  if (url.pathname === '/v1/notes/counts')
    return json(await call(dependencies.counts, hostedNoteCounts)(config.recordDatabaseUrl, who))
  const match = /^\/v1\/notes\/([0-9a-f-]{36})$/i.exec(url.pathname)
  if (!match) return null
  const value = await call(dependencies.get, getHostedNote)(
    config.recordDatabaseUrl,
    who,
    match[1]!,
  )
  return value ? json(value) : json({ error: 'note not found' }, 404)
}

async function noteWriteRoute(context: RouteContext): Promise<Response | null> {
  const { request, url, config, dependencies, who, body } = context
  if (request.method === 'POST' && url.pathname === '/v1/notes') {
    const value = await call(dependencies.create, createHostedNote)(
      config.recordDatabaseUrl,
      who,
      body as never,
    )
    return value ? json(value, 201) : json({ error: 'note not found' }, 404)
  }
  return null
}

async function noteActionRoute(context: RouteContext): Promise<Response | null> {
  const { request, url, config, dependencies, who, body } = context
  if (request.method !== 'POST') return null
  const promote = /^\/v1\/notes\/([0-9a-f-]{36})\/promote$/i.exec(url.pathname)
  if (promote) {
    const task = typeof body?.task === 'string' ? body.task : undefined
    let input: PromoteNoteInput
    if (task !== undefined) input = { task }
    else {
      try {
        input = {
          title: requiredPromotionTitle(
            typeof body?.title === 'string' ? body.title : undefined,
            HOSTED_PROMOTION_TITLE_REFUSAL,
          ),
        }
      } catch (error) {
        return json({ error: (error as Error).message }, 400)
      }
    }
    const value = await call(dependencies.promote, promoteHostedNote)(
      config.recordDatabaseUrl,
      who,
      promote[1]!,
      input,
    )
    return value ? json(value) : json({ error: 'note not found' }, 404)
  }
  return null
}

async function batchRoute(context: RouteContext): Promise<Response | null> {
  const { request, url, config, dependencies, who, body } = context
  if (request.method === 'POST' && url.pathname === '/v1/notes/reap') {
    const cutoff = body?.cutoff
    if (typeof cutoff !== 'string' || !Number.isFinite(Date.parse(cutoff)))
      throw new Error('reap requires a staleness cutoff')
    for (const field of ['stale', 'annotated', 'restored', 'deleted'] as const) {
      if (!Array.isArray(body?.[field]))
        return json(
          {
            error: `note reap requires ${field} to be an array; run \`${PLATFORM_SLUG} machine update\` and retry`,
          },
          400,
        )
    }
    return json(
      await call(dependencies.reap, reapHostedNotes)(config.recordDatabaseUrl, who, body as never),
    )
  }
  if (request.method === 'PUT' && url.pathname === '/v1/notes/mirror')
    return json(
      await call(dependencies.mirror, mirrorHostedNotes)(
        config.recordDatabaseUrl,
        who,
        body as never,
      ),
    )
  return null
}

export async function noteApi(
  request: Request,
  config: HostedRouteConfig,
  dependencies: Dependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/v1/notes')) return null
  if (process.env.NODE_ENV === 'test' && !dependencies.fetch) throw new Error(TEST_REFUSAL)
  const who = await taskSpaceIdentity(
    request,
    config.recordApiUrl,
    (dependencies.fetch ?? hostedApiFetch) as typeof fetch,
    true,
  )
  const refusal = identityRefusal(who)
  if (refusal) return refusal
  if (who.kind === 'refused-space')
    return json(
      {
        error: `record space '${who.refusedSpace}' is not among the caller's memberships`,
        remedy: `Run \`${PLATFORM_SLUG} record space list\` and choose a space where the caller is a member.`,
      },
      403,
    )
  assertAuthenticatedIdentity(who)
  const body =
    request.method === 'GET'
      ? null
      : ((await request.json().catch(() => null)) as Record<string, unknown> | null)
  try {
    const outside = await outsideRoute({ request, url, config, dependencies, who, body })
    if (outside) return outside
  } catch (error) {
    if (error instanceof HostedOutsideNoteError)
      return json(
        { error: error.message, ...(error.remedy ? { remedy: error.remedy } : {}) },
        error.status,
      )
    return json({ error: (error as Error).message }, 409)
  }
  const access = recordSpaceAccessDecision(
    recordRequestNature(request.method),
    who.spaceId,
    who.memberships,
  )
  if (!access.allowed) return json({ error: access.error, remedy: access.remedy }, 403)
  try {
    const context = { request, url, config, dependencies, who, body }
    return (
      (await readRoute(context)) ??
      (await noteWriteRoute(context)) ??
      (await noteActionRoute(context)) ??
      (await batchRoute(context)) ??
      new Response('not found', { status: 404 })
    )
  } catch (error) {
    return json({ error: (error as Error).message }, 409)
  }
}
