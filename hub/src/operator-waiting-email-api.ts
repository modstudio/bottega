// concern: operator-waiting-email-api
/** Authenticated hosted endpoint for idempotent operator-waiting email delivery. */

import {
  recordRequestNature,
  recordSpaceAccessDecision,
} from '../../shared/record-space-request.ts'
import type { HostedRouteConfig } from './hosted-route-config.ts'
import {
  assertAuthenticatedIdentity,
  identityRefusal,
  taskSpaceIdentity,
} from './hosted-route-identity.ts'
import { operatorWaitingEmailRequestSchema } from './operator-waiting-email-contract.ts'
import {
  OperatorEmailBudgetExceededError,
  sendOperatorWaitingEmail,
} from './operator-waiting-email-hosted.ts'
import type { ReportMailClient } from './report-delivery.ts'
import { sesReportMailClient } from './report-delivery-hosted.ts'

type Dependencies = {
  fetch?: typeof fetch
  mail?: ReportMailClient
  send?: typeof sendOperatorWaitingEmail
}
const TEST_REFUSAL =
  'hub operator waiting email API refuses real clients unless stubs are injected in tests'

export async function operatorWaitingEmailApi(
  request: Request,
  config: HostedRouteConfig,
  dependencies: Dependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/v1/operator-waiting-emails') return null
  if (request.method !== 'POST') return new Response('not found', { status: 404 })
  if (process.env.NODE_ENV === 'test' && (!dependencies.fetch || !dependencies.send))
    throw new Error(TEST_REFUSAL)
  const identity = await taskSpaceIdentity(
    request,
    config.recordApiUrl,
    dependencies.fetch ?? fetch,
    false,
  )
  const refusal = identityRefusal(identity)
  if (refusal) return refusal
  if (identity.kind === 'refused-space')
    throw new Error('operator waiting email identity refused a space it ignored')
  assertAuthenticatedIdentity(identity)
  const access = recordSpaceAccessDecision(
    recordRequestNature(request.method),
    identity.spaceId,
    identity.memberships,
  )
  if (!access.allowed)
    return Response.json({ error: access.error, remedy: access.remedy }, { status: 403 })
  const parsed = operatorWaitingEmailRequestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return Response.json({ error: 'invalid operator waiting email body' }, { status: 400 })
  try {
    const result = await (dependencies.send ?? sendOperatorWaitingEmail)(
      config.recordDatabaseUrl,
      { userId: identity.userId, spaceId: identity.spaceId },
      parsed.data,
      { mail: dependencies.mail ?? sesReportMailClient() },
    )
    return Response.json(
      result.status === 'failed' ? { ...result, error: result.reason } : result,
      result.status === 'failed' ? { status: 502 } : undefined,
    )
  } catch (cause) {
    if (cause instanceof OperatorEmailBudgetExceededError)
      return Response.json({ error: cause.message }, { status: 429 })
    return Response.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 409 },
    )
  }
}
