import { PLATFORM_SLUG } from '../../shared/brand.ts'
import type { RecordSpaceMembership } from '../../shared/record-space-membership.ts'
import {
  recordRequestNature,
  recordSpaceAccessDecision,
} from '../../shared/record-space-request.ts'
import type { HostedRouteConfig } from './hosted-route-config.ts'
import { taskSpaceIdentity } from './hosted-route-identity.ts'
import { listHostedTasks } from './hosted-task-list.ts'
import { hostedTaskPresence, softDeleteHostedTasks } from './hosted-task-prune.ts'
import { createHostedDocument, createHostedTask, getHostedTask } from './hosted-tasks.ts'
import { PUSHABLE_HUB_CHANGE_TABLES } from './push-contract.ts'

const TEST_REFUSAL = `${PLATFORM_SLUG} task API refuses real identity and database clients unless stubs are injected in tests`

type Dependencies = {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  list?: typeof listHostedTasks
  get?: typeof getHostedTask
  create?: typeof createHostedTask
  createDocument?: typeof createHostedDocument
  presence?: typeof hostedTaskPresence
  deleteTasks?: typeof softDeleteHostedTasks
}

const json = (value: unknown, status = 200) => Response.json(value, { status })
const bodyOf = (request: Request) =>
  request.json().catch(() => null) as Promise<Record<string, unknown> | null>

const call = <T>(stub: T | undefined, real: T): T => {
  if (process.env.NODE_ENV === 'test' && !stub) throw new Error(TEST_REFUSAL)
  return stub ?? real
}

function taskRouteHonorsRequestedSpace(method: string, pathname: string): boolean {
  if (method === 'GET' && pathname === '/v1/tasks') return true
  if (method === 'POST' && pathname === '/v1/tasks') return true
  if (method === 'GET')
    return /^\/v1\/tasks\/[^/]+$/.test(pathname) && pathname !== '/v1/tasks/identity'
  return method === 'POST' && /^\/v1\/tasks\/[^/]+\/documents$/.test(pathname)
}

type RouteContext = {
  request: Request
  url: URL
  config: HostedRouteConfig
  dependencies: Dependencies
  who: {
    userId: string
    userName: string | null
    spaceId: string
    spaceIds: string[]
    memberships: RecordSpaceMembership[]
  }
  body: Record<string, unknown> | null
  keyMatch: RegExpExecArray | null
  documentsMatch: RegExpExecArray | null
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
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        includeDeleted: url.searchParams.get('includeDeleted') === 'true',
      }),
    )
  if (request.method !== 'GET' || !keyMatch) return null
  const value = await call(dependencies.get, getHostedTask)(
    config.recordDatabaseUrl,
    who,
    decodeURIComponent(keyMatch[1]!),
  )
  return value ? json(value) : json({ error: 'task not found' }, 404)
}

async function taskWriteRoute(ctx: RouteContext): Promise<Response | null> {
  const { request, url, config, dependencies, who, body } = ctx
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
  return null
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
  const { request, config, dependencies, who, body, documentsMatch } = ctx
  if (request.method === 'POST' && documentsMatch) {
    const value = await call(dependencies.createDocument, createHostedDocument)(
      config.recordDatabaseUrl,
      who,
      decodeURIComponent(documentsMatch[1]!),
      body as Parameters<typeof createHostedDocument>[3],
    )
    return value ? json(value, 201) : json({ error: 'task not found' }, 404)
  }
  return null
}

export async function taskApi(
  request: Request,
  config: HostedRouteConfig,
  dependencies: Dependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/v1/tasks')) return null
  if (process.env.NODE_ENV === 'test' && !dependencies.fetch) throw new Error(TEST_REFUSAL)
  const keyMatch = /^\/v1\/tasks\/([^/]+)$/.exec(url.pathname)
  const documentsMatch = /^\/v1\/tasks\/([^/]+)\/documents$/.exec(url.pathname)
  const honorRequestedSpace = taskRouteHonorsRequestedSpace(request.method, url.pathname)
  const who = await taskSpaceIdentity(
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
        remedy: `Run \`${PLATFORM_SLUG} record space list\` and choose a space where the caller is a member.`,
      },
      403,
    )
  const access = recordSpaceAccessDecision(
    recordRequestNature(request.method),
    who.spaceId,
    who.memberships,
  )
  if (!access.allowed) return json({ error: access.error, remedy: access.remedy }, 403)
  if (request.method === 'GET' && url.pathname === '/v1/tasks/identity')
    return json({
      userId: who.userId,
      userName: who.userName,
      activeSpaceId: who.spaceId,
      memberships: who.memberships,
      capabilities: {
        projectNoteCounters: true,
        targetSpaceNotes: true,
        noteTriageStaleness: true,
        spaceChanges: true,
        spacePush: true,
        spacePushTables: PUSHABLE_HUB_CHANGE_TABLES,
        spaceIdentitySet: true,
      },
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
      documentsMatch,
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
