import {
  parseRecordSpaceMemberships,
  type RecordSpaceMembership,
} from '../../shared/record-space-membership.ts'
import { hostedTaskPresence, softDeleteHostedTasks } from './hosted-task-prune.ts'
import {
  addHostedComment,
  createHostedDocument,
  createHostedTask,
  getHostedTask,
  hostedTaskCounts,
  listHostedTasks,
  mirrorHostedTasks,
  patchHostedDocument,
  patchHostedTask,
  softDeleteHostedDocuments,
} from './hosted-tasks.ts'
import { taskRequestSpaceDecision } from './record-space-request.ts'

const TEST_REFUSAL =
  'hub task API refuses real identity and database clients unless stubs are injected in tests'

type Config = { recordApiUrl: string; recordDatabaseUrl: string }
type Dependencies = {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  list?: typeof listHostedTasks
  get?: typeof getHostedTask
  create?: typeof createHostedTask
  patch?: typeof patchHostedTask
  comment?: typeof addHostedComment
  createDocument?: typeof createHostedDocument
  patchDocument?: typeof patchHostedDocument
  deleteDocuments?: typeof softDeleteHostedDocuments
  presence?: typeof hostedTaskPresence
  deleteTasks?: typeof softDeleteHostedTasks
  mirror?: typeof mirrorHostedTasks
  counts?: typeof hostedTaskCounts
}

async function identity(
  request: Request,
  base: string,
  fetchImpl: typeof fetch,
  honorRequestedSpace: boolean,
) {
  const authorization = request.headers.get('authorization')
  if (!authorization) return null
  const response = await fetchImpl(`${base.replace(/\/$/, '')}/v1/whoami`, {
    headers: { authorization },
  })
  if (!response.ok) return null
  const value = (await response.json().catch(() => null)) as Record<string, unknown> | null
  const user = value?.user as Record<string, unknown> | undefined
  const memberships = parseRecordSpaceMemberships(value?.memberships)
  if (typeof user?.id !== 'string' || typeof value?.activeSpaceId !== 'string') return null
  const decision = taskRequestSpaceDecision(
    honorRequestedSpace ? request.headers.get('x-record-space') : null,
    value.activeSpaceId,
    memberships,
  )
  if (!decision.allowed) return { refusedSpace: decision.requestedSpace }
  return {
    userId: user.id,
    spaceId: decision.spaceId,
    spaceIds: memberships.map((row) => row.spaceId),
    memberships,
  }
}

const json = (value: unknown, status = 200) => Response.json(value, { status })
const bodyOf = (request: Request) =>
  request.json().catch(() => null) as Promise<Record<string, unknown> | null>

const call = <T>(stub: T | undefined, real: T): T => {
  if (process.env.NODE_ENV === 'test' && !stub) throw new Error(TEST_REFUSAL)
  return stub ?? real
}

function taskRouteHonorsRequestedSpace(method: string, pathname: string): boolean {
  if (method === 'PUT' && pathname === '/v1/tasks/mirror') return true
  if (method === 'GET' && pathname === '/v1/tasks/counts') return true
  if (method === 'POST' && pathname === '/v1/tasks') return true
  if (method === 'GET')
    return /^\/v1\/tasks\/[^/]+$/.test(pathname) && pathname !== '/v1/tasks/identity'
  if (method === 'PATCH')
    return (
      /^\/v1\/tasks\/[^/]+$/.test(pathname) ||
      /^\/v1\/tasks\/[^/]+\/documents\/[^/]+$/.test(pathname)
    )
  if (method === 'DELETE') return /^\/v1\/tasks\/[^/]+\/documents\/[^/]+$/.test(pathname)
  if (method !== 'POST') return false
  return /^\/v1\/tasks\/[^/]+\/(?:comments|documents|close)$/.test(pathname)
}

type RouteContext = {
  request: Request
  url: URL
  config: Config
  dependencies: Dependencies
  who: {
    userId: string
    spaceId: string
    spaceIds: string[]
    memberships: RecordSpaceMembership[]
  }
  body: Record<string, unknown> | null
  keyMatch: RegExpExecArray | null
  commentMatch: RegExpExecArray | null
  documentsMatch: RegExpExecArray | null
  documentMatch: RegExpExecArray | null
  closeMatch: RegExpExecArray | null
}

async function readRoute(ctx: RouteContext): Promise<Response | null> {
  const { request, url, config, dependencies, who, keyMatch } = ctx
  if (request.method === 'GET' && url.pathname === '/v1/tasks')
    return json(
      await call(dependencies.list, listHostedTasks)(config.recordDatabaseUrl, who, {
        project: url.searchParams.get('project') ?? undefined,
        status: url.searchParams.get('status') ?? undefined,
        parent: url.searchParams.get('parent') ?? undefined,
        updatedSince: url.searchParams.get('updatedSince') ?? undefined,
        cursor: url.searchParams.get('cursor') ?? undefined,
        includeDeleted: url.searchParams.get('includeDeleted') === 'true',
      }),
    )
  if (request.method === 'GET' && url.pathname === '/v1/tasks/counts') {
    return json(await call(dependencies.counts, hostedTaskCounts)(config.recordDatabaseUrl, who))
  }
  if (request.method !== 'GET' || !keyMatch) return null
  const value = await call(dependencies.get, getHostedTask)(
    config.recordDatabaseUrl,
    who,
    decodeURIComponent(keyMatch[1]!),
  )
  return value ? json(value) : json({ error: 'task not found' }, 404)
}

async function taskWriteRoute(ctx: RouteContext): Promise<Response | null> {
  const { request, url, config, dependencies, who, body, keyMatch, closeMatch } = ctx
  const bulk = await taskBulkRoute(ctx)
  if (bulk) return bulk
  if (request.method === 'POST' && url.pathname === '/v1/tasks')
    return json(
      await call(dependencies.create, createHostedTask)(
        config.recordDatabaseUrl,
        who,
        body as Parameters<typeof createHostedTask>[2],
      ),
      201,
    )
  if (request.method === 'PATCH' && keyMatch) {
    const value = await call(dependencies.patch, patchHostedTask)(
      config.recordDatabaseUrl,
      who,
      decodeURIComponent(keyMatch[1]!),
      body as Parameters<typeof patchHostedTask>[3],
    )
    return value ? json(value) : json({ error: 'task not found' }, 404)
  }
  if (request.method === 'POST' && closeMatch) {
    const value = await call(dependencies.patch, patchHostedTask)(
      config.recordDatabaseUrl,
      who,
      decodeURIComponent(closeMatch[1]!),
      { status: 'done', status_category: 'done' },
    )
    return value ? json(value) : json({ error: 'task not found' }, 404)
  }
  if (request.method !== 'PUT' || url.pathname !== '/v1/tasks/mirror') return null
  return json(
    await call(dependencies.mirror, mirrorHostedTasks)(
      config.recordDatabaseUrl,
      who,
      body as Parameters<typeof mirrorHostedTasks>[2],
    ),
  )
}

async function taskBulkRoute(ctx: RouteContext): Promise<Response | null> {
  const { request, url, config, dependencies, who, body } = ctx
  if (request.method === 'POST' && url.pathname === '/v1/tasks/presence')
    return json(
      await call(dependencies.presence, hostedTaskPresence)(
        config.recordDatabaseUrl,
        who,
        Array.isArray(body?.pairs)
          ? (body.pairs as Array<{ space_id: string; key: string }>).filter(
              (pair) => typeof pair?.space_id === 'string' && typeof pair?.key === 'string',
            )
          : [],
      ),
    )
  if (request.method === 'DELETE' && url.pathname === '/v1/tasks')
    return json(
      await call(dependencies.deleteTasks, softDeleteHostedTasks)(
        config.recordDatabaseUrl,
        who,
        Array.isArray(body?.ids)
          ? body.ids.filter((id): id is string => typeof id === 'string')
          : [],
        typeof body?.confirmation === 'number' ? body.confirmation : undefined,
      ),
    )
  return null
}

async function childWriteRoute(ctx: RouteContext): Promise<Response | null> {
  const { request, config, dependencies, who, body, commentMatch, documentsMatch, documentMatch } =
    ctx
  if (request.method === 'POST' && commentMatch) {
    const value = await call(dependencies.comment, addHostedComment)(
      config.recordDatabaseUrl,
      who,
      decodeURIComponent(commentMatch[1]!),
      String(body?.body ?? ''),
    )
    return value ? json(value, 201) : json({ error: 'task not found' }, 404)
  }
  if (request.method === 'POST' && documentsMatch) {
    const value = await call(dependencies.createDocument, createHostedDocument)(
      config.recordDatabaseUrl,
      who,
      decodeURIComponent(documentsMatch[1]!),
      body as Parameters<typeof createHostedDocument>[3],
    )
    return value ? json(value, 201) : json({ error: 'task not found' }, 404)
  }
  if (request.method === 'PATCH' && documentMatch) {
    const value = await call(dependencies.patchDocument, patchHostedDocument)(
      config.recordDatabaseUrl,
      who,
      documentMatch[2]!,
      body as Parameters<typeof patchHostedDocument>[3],
    )
    return value ? json(value) : json({ error: 'document not found' }, 404)
  }
  if (request.method !== 'DELETE' || !documentMatch) return null
  return json(
    await call(dependencies.deleteDocuments, softDeleteHostedDocuments)(
      config.recordDatabaseUrl,
      who,
      [documentMatch[2]!],
    ),
  )
}

export async function taskApi(
  request: Request,
  config: Config,
  dependencies: Dependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/v1/tasks')) return null
  if (process.env.NODE_ENV === 'test' && !dependencies.fetch) throw new Error(TEST_REFUSAL)
  const keyMatch = /^\/v1\/tasks\/([^/]+)$/.exec(url.pathname)
  const commentMatch = /^\/v1\/tasks\/([^/]+)\/comments$/.exec(url.pathname)
  const documentsMatch = /^\/v1\/tasks\/([^/]+)\/documents$/.exec(url.pathname)
  const documentMatch = /^\/v1\/tasks\/([^/]+)\/documents\/([^/]+)$/.exec(url.pathname)
  const closeMatch = /^\/v1\/tasks\/([^/]+)\/close$/.exec(url.pathname)
  const honorRequestedSpace = taskRouteHonorsRequestedSpace(request.method, url.pathname)
  const who = await identity(
    request,
    config.recordApiUrl,
    (dependencies.fetch ?? fetch) as typeof fetch,
    honorRequestedSpace,
  )
  if (!who) return json({ error: 'authorization and an active space are required' }, 401)
  if ('refusedSpace' in who)
    return json(
      {
        error: `record space '${who.refusedSpace}' is not among the caller's memberships`,
        remedy: 'Run `orch record space list` and choose a space where the caller is a member.',
      },
      403,
    )
  if (request.method === 'GET' && url.pathname === '/v1/tasks/identity')
    return json({
      userId: who.userId,
      activeSpaceId: who.spaceId,
      memberships: who.memberships,
      capabilities: { targetSpaceTaskMirror: true, targetSpaceIntervalEvidence: true },
    })
  const body = request.method === 'GET' ? null : await bodyOf(request)
  try {
    const context: RouteContext = {
      request,
      url,
      config,
      dependencies,
      who,
      body,
      keyMatch,
      commentMatch,
      documentsMatch,
      documentMatch,
      closeMatch,
    }
    const response =
      (await readRoute(context)) ??
      (await taskWriteRoute(context)) ??
      (await childWriteRoute(context))
    if (response) return response
    return new Response('not found', { status: 404 })
  } catch (error) {
    return json({ error: (error as Error).message }, 409)
  }
}
