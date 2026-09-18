import { readRecordSessionToken } from '../../shared/record-session.ts'
import type {
  HostedReportSubscription,
  HostedSend,
  ReportSubscriptionWriteInput,
} from './hosted-reports.ts'

const TEST_REFUSAL =
  'hub report client refuses a real hosted URL unless a stub is injected in tests'
const REMEDY = 'Set HUB_HOSTED_URL and run `orch record doctor`.'
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
): Promise<T> {
  const baseUrl = options.baseUrl ?? process.env.HUB_HOSTED_URL
  if (!baseUrl) throw new Error(`hosted hub is not configured. ${REMEDY}`)
  if (process.env.NODE_ENV === 'test' && !options.fetch) throw new Error(TEST_REFUSAL)
  const token = options.token ?? readRecordSessionToken()
  if (!token)
    throw new Error(
      'record session is absent. Run `orch record sign-in`, then `orch record doctor`.',
    )
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    throw new Error(`hosted hub is unreachable: ${(error as Error).message}. ${REMEDY}`)
  }
  const value = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok)
    throw new Error(
      `hosted hub refused the request (${response.status}): ${String(value?.error ?? 'unknown error')}. ${REMEDY}`,
    )
  return value as T
}

export async function hostedSendChanges(cursor: string | null, options?: ReportClientOptions) {
  const query = new URLSearchParams({ limit: '1000' })
  if (cursor) query.set('cursor', cursor)
  return request<{ sends: HostedSend[]; cursor: string }>(
    `/v1/sends?${query}`,
    'GET',
    undefined,
    options,
  )
}
export const hostedMirrorReports = (body: unknown, options?: ReportClientOptions) =>
  request<{ upserted: number }>('/v1/sends/mirror', 'PUT', body, options)
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
) => request<HostedReportSubscription>('/v1/report-subscriptions', 'POST', body, options)
export const hostedUnsubscribeReportSubscription = (id: string, options?: ReportClientOptions) =>
  request<{ id: string; deleted: boolean }>(
    `/v1/report-subscriptions/${id}`,
    'DELETE',
    undefined,
    options,
  )
