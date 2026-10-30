import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { jsonBody } from '../../shared/http-json.ts'
import { readRecordSessionToken } from '../../shared/record-session.ts'
import { type HostedRequestSafety, hostedRefusalError } from './hosted-refusal.ts'
import type {
  HostedReportSubscription,
  HostedSend,
  ReportSubscriptionWriteInput,
} from './hosted-reports.ts'
import { HOSTED_SEND_PAGE_SIZE } from './hosted-reports.ts'
import { resolveHostedUrl } from './hosted-url.ts'
import { MISSING_HOSTED_URL_REMEDY } from './hosted-write-mode.ts'

const TEST_REFUSAL = `${PLATFORM_SLUG} report client refuses a real hosted URL unless a stub is injected in tests`
const REMEDY = MISSING_HOSTED_URL_REMEDY
type ReportFetch = (input: string, init?: RequestInit) => Promise<Response>
export type ReportClientOptions = {
  baseUrl?: string
  token?: string | null
  fetch?: ReportFetch
}

async function request<T>(
  path: string,
  method: string,
  body?: unknown,
  options: ReportClientOptions = {},
  safety: HostedRequestSafety = 'probe',
): Promise<T> {
  const baseUrl = options.baseUrl ?? resolveHostedUrl()
  if (!baseUrl) throw new Error(`hosted hub is not configured. ${REMEDY}`)
  if (process.env.NODE_ENV === 'test' && !options.fetch) throw new Error(TEST_REFUSAL)
  const token = options.token ?? readRecordSessionToken()
  if (!token)
    throw new Error(
      `record session is absent. Run \`${PLATFORM_SLUG} record sign-in\`, then \`${PLATFORM_SLUG} record doctor\`.`,
    )
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    throw hostedRefusalError({ cause: error, safety })
  }
  const url = `${baseUrl.replace(/\/$/, '')}${path}`
  const bodyResult = await jsonBody(response, url)
  if (!bodyResult.ok)
    throw hostedRefusalError({
      status: response.status,
      statusText: response.statusText,
      safety,
    })
  const value = bodyResult.value as Record<string, unknown> | null
  if (!response.ok)
    throw hostedRefusalError({
      status: response.status,
      statusText: response.statusText,
      body: value,
      safety,
    })
  return value as T
}

export async function hostedSendChanges(cursor: string | null, options?: ReportClientOptions) {
  const query = new URLSearchParams({ limit: String(HOSTED_SEND_PAGE_SIZE) })
  if (cursor) query.set('cursor', cursor)
  return request<{ sends: HostedSend[]; cursor: string | null; more: boolean }>(
    `/v1/sends?${query}`,
    'GET',
    undefined,
    options,
  )
}
export const hostedMirrorReports = (body: unknown, options?: ReportClientOptions) =>
  request<{ upserted: number }>('/v1/sends/mirror', 'PUT', body, options, 'idempotent')
export const hostedReportCounts = (options?: ReportClientOptions) =>
  request<{ sends: number }>('/v1/sends/counts', 'GET', undefined, options)
export const hostedListReportSubscriptions = (options?: ReportClientOptions) =>
  request<{ subscriptions: HostedReportSubscription[] }>(
    '/v1/report-subscriptions',
    'GET',
    undefined,
    options,
  )
export const hostedCreateReportSubscription = (
  body: ReportSubscriptionWriteInput,
  options?: ReportClientOptions,
) =>
  request<HostedReportSubscription>(
    '/v1/report-subscriptions',
    'POST',
    body,
    options,
    'non-idempotent',
  )
export const hostedUnsubscribeReportSubscription = (id: string, options?: ReportClientOptions) =>
  request<{ id: string; deleted: boolean }>(
    `/v1/report-subscriptions/${id}`,
    'DELETE',
    undefined,
    options,
    'idempotent',
  )
