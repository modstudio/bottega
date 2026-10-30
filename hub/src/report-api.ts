import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  recordRequestNature,
  recordSpaceAccessDecision,
} from '../../shared/record-space-request.ts'
import {
  appendHostedSend,
  createHostedReportSubscription,
  hostedEmailRecipientByToken,
  hostedReportCounts,
  listHostedReportSubscriptions,
  listHostedSends,
  mirrorHostedReports,
  unsubscribeHostedEmailRecipient,
  unsubscribeHostedReportSubscription,
  updateHostedReportSubscription,
} from './hosted-reports.ts'
import type { HostedRouteConfig } from './hosted-route-config.ts'
import { identityRefusalResponse, taskSpaceIdentity } from './hosted-route-identity.ts'

const TEST_REFUSAL = `${PLATFORM_SLUG} report API refuses real identity and database clients unless stubs are injected in tests`
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

async function sendRoute(
  request: Request,
  url: URL,
  config: HostedRouteConfig,
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
  config: HostedRouteConfig,
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
  config: HostedRouteConfig,
  dependencies: Dependencies,
  who: { userId: string; spaceId: string },
  body: Record<string, unknown> | null,
) {
  return (
    (await sendRoute(request, url, config, dependencies, who, body)) ??
    (await subscriptionRoute(request, url, config, dependencies, who, body)) ??
    new Response('not found', { status: 404 })
  )
}

export async function reportApi(
  request: Request,
  config: HostedRouteConfig,
  dependencies: Dependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url)
  const emailUnsubscribe = /^\/v1\/report-unsubscribe\/([^/]+)\/([^/]+)$/.exec(url.pathname)
  const oneClickUnsubscribe = /^\/unsubscribe\/([^/]+)\/([^/]+)$/.exec(url.pathname)
  if (emailUnsubscribe && request.method === 'GET')
    return json(
      await call(dependencies.emailRecipientByToken, hostedEmailRecipientByToken)(
        config.recordDatabaseUrl,
        emailUnsubscribe[1]!,
        emailUnsubscribe[2]!,
      ),
    )
  const postedUnsubscribe = emailUnsubscribe ?? oneClickUnsubscribe
  if (postedUnsubscribe && request.method === 'POST')
    return json({
      unsubscribed: await call(
        dependencies.unsubscribeEmailRecipient,
        unsubscribeHostedEmailRecipient,
      )(config.recordDatabaseUrl, postedUnsubscribe[1]!, postedUnsubscribe[2]!),
    })
  if (!url.pathname.startsWith('/v1/report-subscriptions') && !url.pathname.startsWith('/v1/sends'))
    return null
  if (process.env.NODE_ENV === 'test' && !dependencies.fetch) throw new Error(TEST_REFUSAL)
  const identity = await taskSpaceIdentity(
    request,
    config.recordApiUrl,
    (dependencies.fetch ?? fetch) as typeof fetch,
    false,
  )
  if (identity.kind === 'unauthenticated' || identity.kind === 'unavailable')
    return identityRefusalResponse(identity)
  if (identity.kind === 'refused-space')
    throw new Error('report identity refused a space it ignored')
  const access = recordSpaceAccessDecision(
    recordRequestNature(request.method),
    identity.spaceId,
    identity.memberships,
  )
  if (!access.allowed) return json({ error: access.error, remedy: access.remedy }, 403)
  const who = { userId: identity.userId, spaceId: identity.spaceId }
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
