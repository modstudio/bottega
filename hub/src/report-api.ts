import {
  appendHostedSend,
  createHostedReportSubscription,
  getHostedReportSetting,
  hostedReportCounts,
  listHostedReportSubscriptions,
  listHostedSends,
  mirrorHostedReports,
  putHostedReportSetting,
  unsubscribeHostedReportSubscription,
  updateHostedReportSubscription,
} from './hosted-reports.ts'

const TEST_REFUSAL =
  'hub report API refuses real identity and database clients unless stubs are injected in tests'
type Config = { recordApiUrl: string; recordDatabaseUrl: string }
type Dependencies = { fetch?: typeof fetch; [key: string]: unknown }
const json = (value: unknown, status = 200) => Response.json(value, { status })
const call = <T>(stub: unknown, real: T): T => {
  if (process.env.NODE_ENV === 'test' && !stub) throw new Error(TEST_REFUSAL)
  return (stub ?? real) as T
}

const sendFilters = (url: URL) => ({
  limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
  updatedSince: url.searchParams.get('updatedSince') ?? undefined,
  cursor: url.searchParams.get('cursor') ?? undefined,
})

async function settingRoute(
  request: Request,
  url: URL,
  config: Config,
  dependencies: Dependencies,
  who: { userId: string; spaceId: string },
  body: Record<string, unknown> | null,
) {
  if (request.method === 'GET' && url.pathname === '/v1/report-setting') {
    const value = await call(dependencies.getSetting, getHostedReportSetting)(
      config.recordDatabaseUrl,
      who,
    )
    return value ? json(value) : json({ error: 'report setting is not configured' }, 404)
  }
  if (request.method === 'PUT' && url.pathname === '/v1/report-setting')
    return json(
      await call(dependencies.putSetting, putHostedReportSetting)(
        config.recordDatabaseUrl,
        who,
        body as never,
      ),
    )
  return null
}

async function sendRoute(
  request: Request,
  url: URL,
  config: Config,
  dependencies: Dependencies,
  who: { userId: string; spaceId: string },
  body: Record<string, unknown> | null,
) {
  if (request.method === 'GET' && url.pathname === '/v1/sends/counts')
    return json(await call(dependencies.counts, hostedReportCounts)(config.recordDatabaseUrl, who))
  if (request.method === 'GET' && url.pathname === '/v1/sends')
    return json(
      await call(dependencies.listSends, listHostedSends)(
        config.recordDatabaseUrl,
        who,
        sendFilters(url),
      ),
    )
  if (request.method === 'POST' && url.pathname === '/v1/sends')
    return json(
      await call(dependencies.appendSend, appendHostedSend)(
        config.recordDatabaseUrl,
        who,
        body as never,
      ),
      201,
    )
  if (request.method === 'PUT' && url.pathname === '/v1/sends/mirror')
    return json(
      await call(dependencies.mirror, mirrorHostedReports)(
        config.recordDatabaseUrl,
        who,
        body as never,
      ),
    )
  return null
}

async function subscriptionRoute(
  request: Request,
  url: URL,
  config: Config,
  dependencies: Dependencies,
  who: { userId: string; spaceId: string },
  body: Record<string, unknown> | null,
) {
  if (request.method === 'GET' && url.pathname === '/v1/report-subscriptions')
    return json(
      await call(dependencies.listSubscriptions, listHostedReportSubscriptions)(
        config.recordDatabaseUrl,
        who,
      ),
    )
  if (request.method === 'POST' && url.pathname === '/v1/report-subscriptions')
    return json(
      await call(dependencies.createSubscription, createHostedReportSubscription)(
        config.recordDatabaseUrl,
        who,
        body as never,
      ),
      201,
    )
  const unsubscribe = /^\/v1\/report-subscriptions\/([^/]+)$/.exec(url.pathname)
  if (request.method === 'PUT' && unsubscribe)
    return json(
      await call(dependencies.updateSubscription, updateHostedReportSubscription)(
        config.recordDatabaseUrl,
        who,
        unsubscribe[1]!,
        body as never,
      ),
    )
  if (request.method === 'DELETE' && unsubscribe)
    return json(
      await call(dependencies.unsubscribe, unsubscribeHostedReportSubscription)(
        config.recordDatabaseUrl,
        who,
        unsubscribe[1]!,
      ),
    )
  return null
}

async function dispatchReportRequest(
  request: Request,
  url: URL,
  config: Config,
  dependencies: Dependencies,
  who: { userId: string; spaceId: string },
  body: Record<string, unknown> | null,
) {
  return (
    (await settingRoute(request, url, config, dependencies, who, body)) ??
    (await sendRoute(request, url, config, dependencies, who, body)) ??
    (await subscriptionRoute(request, url, config, dependencies, who, body)) ??
    new Response('not found', { status: 404 })
  )
}

export async function reportApi(
  request: Request,
  config: Config,
  dependencies: Dependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url)
  if (
    !url.pathname.startsWith('/v1/report-setting') &&
    !url.pathname.startsWith('/v1/report-subscriptions') &&
    !url.pathname.startsWith('/v1/sends')
  )
    return null
  if (process.env.NODE_ENV === 'test' && !dependencies.fetch) throw new Error(TEST_REFUSAL)
  const authorization = request.headers.get('authorization')
  if (!authorization) return json({ error: 'authorization and an active space are required' }, 401)
  const response = await (dependencies.fetch ?? fetch)(
    `${config.recordApiUrl.replace(/\/$/, '')}/v1/whoami`,
    { headers: { authorization } },
  )
  const identity = (await response.json().catch(() => null)) as {
    user?: { id?: string }
    activeSpaceId?: string
  } | null
  if (!response.ok || !identity?.user?.id || !identity.activeSpaceId)
    return json({ error: 'authorization and an active space are required' }, 401)
  const who = { userId: identity.user.id, spaceId: identity.activeSpaceId }
  const body =
    request.method === 'GET'
      ? null
      : ((await request.json().catch(() => null)) as Record<string, unknown> | null)
  try {
    return await dispatchReportRequest(request, url, config, dependencies, who, body)
  } catch (error) {
    return json({ error: (error as Error).message }, 409)
  }
}
