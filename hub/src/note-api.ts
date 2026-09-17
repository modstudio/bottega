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
type Identity = { userId: string; spaceId: string }
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
): Promise<Identity | null> {
  const authorization = request.headers.get('authorization')
  if (!authorization) return null
  const response = await (dependencies.fetch ?? fetch)(
    `${config.recordApiUrl.replace(/\/$/, '')}/v1/whoami`,
    { headers: { authorization } },
  )
  const identity = (await response.json().catch(() => null)) as {
    user?: { id?: string }
    activeSpaceId?: string
  } | null
  if (!response.ok || !identity?.user?.id || !identity.activeSpaceId) return null
  return { userId: identity.user.id, spaceId: identity.activeSpaceId }
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
  const match = /^\/v1\/notes\/(\d+)$/.exec(url.pathname)
  if (!match) return null
  const value = await call(dependencies.get, getHostedNote)(
    config.recordDatabaseUrl,
    who,
    Number(match[1]),
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
  const match = /^\/v1\/notes\/(\d+)$/.exec(url.pathname)
  if (request.method === 'PATCH' && match) {
    const value = await call(dependencies.patch, patchHostedNote)(
      config.recordDatabaseUrl,
      who,
      Number(match[1]),
      body as never,
    )
    return value ? json(value) : json({ error: 'note not found' }, 404)
  }
  const ack = /^\/v1\/notes\/(\d+)\/acknowledgements$/.exec(url.pathname)
  if (request.method !== 'POST' || !ack) return null
  const value = await call(dependencies.acknowledge, acknowledgeHostedNote)(
    config.recordDatabaseUrl,
    who,
    Number(ack[1]),
    String(body?.session ?? ''),
  )
  return value ? json(value, 201) : json({ error: 'note not found' }, 404)
}

async function noteActionRoute(context: RouteContext): Promise<Response | null> {
  const { request, url, config, dependencies, who, body } = context
  if (request.method !== 'POST') return null
  const promote = /^\/v1\/notes\/(\d+)\/promote$/.exec(url.pathname)
  if (promote) {
    const value = await call(dependencies.promote, promoteHostedNote)(
      config.recordDatabaseUrl,
      who,
      Number(promote[1]),
    )
    return value ? json(value) : json({ error: 'note not found' }, 404)
  }
  const drop = /^\/v1\/notes\/(\d+)\/drop$/.exec(url.pathname)
  if (drop) {
    const value = await call(dependencies.drop, dropHostedNote)(
      config.recordDatabaseUrl,
      who,
      Number(drop[1]),
      String(body?.reason ?? ''),
    )
    return value ? json(value) : json({ error: 'note not found' }, 404)
  }
  if (url.pathname !== '/v1/notes/merge') return null
  const value = await call(dependencies.merge, mergeHostedNotes)(
    config.recordDatabaseUrl,
    who,
    Number(body?.target),
    Number(body?.source),
  )
  return value ? json(value) : json({ error: 'note not found' }, 404)
}

async function batchRoute(context: RouteContext): Promise<Response | null> {
  const { request, url, config, dependencies, who, body } = context
  if (request.method === 'POST' && url.pathname === '/v1/notes/reap')
    return json(
      await call(dependencies.reap, reapHostedNotes)(config.recordDatabaseUrl, who, body as never),
    )
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
