import {
  parseRecordSpaceMemberships,
  type RecordSpaceMembership,
} from '../../shared/record-space-membership.ts'
import {
  recordSpaceAccessDecision,
  recordRequestNature,
  recordSpaceRequestDecision,
} from '../../shared/record-space-request.ts'
import {
  acknowledgeHostedNote,
  createHostedNote,
  dropHostedNote,
  getHostedNote,
  hostedNoteCounts,
  listHostedNotes,
  mergeHostedNotes,
  mirrorHostedNotes,
  patchHostedNote,
  promoteHostedNote,
  reapHostedNotes,
} from './hosted-notes.ts'

const TEST_REFUSAL =
  'hub note API refuses real identity and database clients unless stubs are injected in tests'
type Config = { recordApiUrl: string; recordDatabaseUrl: string }
type Dependencies = { fetch?: typeof fetch; [key: string]: unknown }
type Identity = { userId: string; spaceId: string; memberships: RecordSpaceMembership[] }
type RouteContext = {
  request: Request
  url: URL
  config: Config
  dependencies: Dependencies
  who: Identity
  body: Record<string, unknown> | null
}
const json = (value: unknown, status = 200) => Response.json(value, { status })
const call = <T>(stub: unknown, real: T): T => {
  if (process.env.NODE_ENV === 'test' && !stub) throw new Error(TEST_REFUSAL)
  return (stub ?? real) as T
}

async function authenticate(
  request: Request,
  config: Config,
  dependencies: Dependencies,
): Promise<Identity | { refusedSpace: string } | null> {
  const authorization = request.headers.get('authorization')
  if (!authorization) return null
  const response = await (dependencies.fetch ?? fetch)(
    `${config.recordApiUrl.replace(/\/$/, '')}/v1/whoami`,
    { headers: { authorization } },
  )
  const identity = (await response.json().catch(() => null)) as {
    user?: { id?: string }
    activeSpaceId?: string
    memberships?: unknown
  } | null
  if (!response.ok || !identity?.user?.id || !identity.activeSpaceId) return null
  const memberships = parseRecordSpaceMemberships(identity.memberships)
  const decision = recordSpaceRequestDecision(
    request.headers.get('x-record-space'),
    identity.activeSpaceId,
    memberships,
  )
  if (!decision.allowed) return { refusedSpace: decision.requestedSpace }
  return { userId: identity.user.id, spaceId: decision.spaceId!, memberships }
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
  const match = /^\/v1\/notes\/([0-9a-f-]{36})$/i.exec(url.pathname)
  if (request.method === 'PATCH' && match) {
    const value = await call(dependencies.patch, patchHostedNote)(
      config.recordDatabaseUrl,
      who,
      match[1]!,
      body as never,
    )
    return value ? json(value) : json({ error: 'note not found' }, 404)
  }
  const ack = /^\/v1\/notes\/([0-9a-f-]{36})\/acknowledgements$/i.exec(url.pathname)
  if (request.method !== 'POST' || !ack) return null
  const value = await call(dependencies.acknowledge, acknowledgeHostedNote)(
    config.recordDatabaseUrl,
    who,
    ack[1]!,
    String(body?.session ?? ''),
  )
  return value ? json(value, 201) : json({ error: 'note not found' }, 404)
}

async function noteActionRoute(context: RouteContext): Promise<Response | null> {
  const { request, url, config, dependencies, who, body } = context
  if (request.method !== 'POST') return null
  const promote = /^\/v1\/notes\/([0-9a-f-]{36})\/promote$/i.exec(url.pathname)
  if (promote) {
    const value = await call(dependencies.promote, promoteHostedNote)(
      config.recordDatabaseUrl,
      who,
      promote[1]!,
      { task: typeof body?.task === 'string' ? body.task : undefined },
    )
    return value ? json(value) : json({ error: 'note not found' }, 404)
  }
  const drop = /^\/v1\/notes\/([0-9a-f-]{36})\/drop$/i.exec(url.pathname)
  if (drop) {
    const value = await call(dependencies.drop, dropHostedNote)(
      config.recordDatabaseUrl,
      who,
      drop[1]!,
      String(body?.reason ?? ''),
    )
    return value ? json(value) : json({ error: 'note not found' }, 404)
  }
  if (url.pathname !== '/v1/notes/merge') return null
  const value = await call(dependencies.merge, mergeHostedNotes)(
    config.recordDatabaseUrl,
    who,
    String(body?.target),
    String(body?.source),
  )
  return value ? json(value) : json({ error: 'note not found' }, 404)
}

async function batchRoute(context: RouteContext): Promise<Response | null> {
  const { request, url, config, dependencies, who, body } = context
  if (request.method === 'POST' && url.pathname === '/v1/notes/reap') {
    const cutoff = body?.cutoff
    if (typeof cutoff !== 'string' || !Number.isFinite(Date.parse(cutoff)))
      throw new Error('reap requires a staleness cutoff')
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
  config: Config,
  dependencies: Dependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/v1/notes')) return null
  if (process.env.NODE_ENV === 'test' && !dependencies.fetch) throw new Error(TEST_REFUSAL)
  const who = await authenticate(request, config, dependencies)
  if (!who) return json({ error: 'authorization and an active space are required' }, 401)
  if ('refusedSpace' in who)
    return json(
      {
        error: `record space '${who.refusedSpace}' is not among the caller's memberships`,
        remedy: 'Run `orch record space list` and choose a space where the caller is a member.',
      },
      403,
    )
  const access = recordSpaceAccessDecision(
    recordRequestNature(request.method),
    who.spaceId,
    who.memberships,
  )
  if (!access.allowed) return json({ error: access.error, remedy: access.remedy }, 403)
  const body =
    request.method === 'GET'
      ? null
      : ((await request.json().catch(() => null)) as Record<string, unknown> | null)
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
