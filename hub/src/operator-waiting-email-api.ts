// concern: operator-waiting-email-api
/** Authenticated hosted endpoint for idempotent operator-waiting email delivery. */

import { z } from 'zod'
import {
  type OperatorWaitingEmailInput,
  sendOperatorWaitingEmail,
} from './operator-waiting-email-hosted.ts'
import type { ReportMailClient } from './report-delivery.ts'
import { sesReportMailClient } from './report-delivery-hosted.ts'

type Config = { recordApiUrl: string; recordDatabaseUrl: string }
type Dependencies = {
  fetch?: typeof fetch
  mail?: ReportMailClient
  send?: typeof sendOperatorWaitingEmail
}
const TEST_REFUSAL =
  'hub operator waiting email API refuses real clients unless stubs are injected in tests'

const bodySchema = z
  .object({
    kind: z.enum(['question', 'workflow']),
    item_id: z.number().int().positive(),
    episode: z.string().min(1),
    project: z.string().min(1),
    task_key: z.string().nullable(),
    question: z.string().min(1),
    options: z.array(z.string()),
    recommendation: z.string().nullable(),
    why: z.string().nullable(),
    waiting_since: z.iso.datetime(),
    link: z.url(),
    answer_command: z.string().min(1),
  })
  .strict()

export async function operatorWaitingEmailApi(
  request: Request,
  config: Config,
  dependencies: Dependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/v1/operator-waiting-emails') return null
  if (request.method !== 'POST') return new Response('not found', { status: 404 })
  if (process.env.NODE_ENV === 'test' && (!dependencies.fetch || !dependencies.send))
    throw new Error(TEST_REFUSAL)
  const authorization = request.headers.get('authorization')
  if (!authorization)
    return Response.json(
      { error: 'authorization and an active space are required' },
      { status: 401 },
    )
  const identityResponse = await (dependencies.fetch ?? fetch)(
    `${config.recordApiUrl.replace(/\/$/, '')}/v1/whoami`,
    { headers: { authorization } },
  )
  const identity = (await identityResponse.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  const user = identity?.user as Record<string, unknown> | undefined
  if (
    !identityResponse.ok ||
    typeof user?.id !== 'string' ||
    typeof identity?.activeSpaceId !== 'string'
  )
    return Response.json(
      { error: 'authorization and an active space are required' },
      { status: 401 },
    )
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return Response.json({ error: 'invalid operator waiting email body' }, { status: 400 })
  try {
    const result = await (dependencies.send ?? sendOperatorWaitingEmail)(
      config.recordDatabaseUrl,
      { userId: user.id, spaceId: identity.activeSpaceId },
      parsed.data as OperatorWaitingEmailInput,
      { mail: dependencies.mail ?? sesReportMailClient() },
    )
    return Response.json(
      result.status === 'failed' ? { ...result, error: result.reason } : result,
      result.status === 'failed' ? { status: 502 } : undefined,
    )
  } catch (cause) {
    return Response.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 409 },
    )
  }
}
