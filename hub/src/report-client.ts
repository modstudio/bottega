import { readRecordSessionToken } from '../../shared/record-session.ts'
import type { HostedReportSetting, HostedSend } from './hosted-reports.ts'

const TEST_REFUSAL =
  'hub report client refuses a real hosted URL unless a stub is injected in tests'
const REMEDY = 'Set HUB_HOSTED_URL and run `orch record doctor`.'
export type ReportFetch = (input: string, init?: RequestInit) => Promise<Response>
export type ReportClientOptions = {
  baseUrl?: string
  token?: string | null
  fetch?: ReportFetch
}

function request<T>(
  path: string,
  method: string,
  body?: unknown,
  options?: ReportClientOptions,
): Promise<T>
function request<T>(
  path: string,
  method: string,
  body: unknown,
  options: ReportClientOptions | undefined,
  notFoundAsNull: true,
): Promise<T | null>
async function request<T>(
  path: string,
  method: string,
  body?: unknown,
  options: ReportClientOptions = {},
  notFoundAsNull = false,
): Promise<T | null> {
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
  if (notFoundAsNull && response.status === 404) return null
  if (!response.ok)
    throw new Error(
      `hosted hub refused the request (${response.status}): ${String(value?.error ?? 'unknown error')}. ${REMEDY}`,
    )
  return value as T
}

export const hostedGetReportSetting = (options?: ReportClientOptions) =>
  request<HostedReportSetting>('/v1/report-setting', 'GET', undefined, options, true)
export const hostedPutReportSetting = (
  body: { value: HostedReportSetting['value']; version: number },
  options?: ReportClientOptions,
) => request<HostedReportSetting>('/v1/report-setting', 'PUT', body, options)
export const hostedAppendSend = (
  body: Omit<HostedSend, 'id' | 'legacy_local_id' | 'created_at'>,
  options?: ReportClientOptions,
) => request<HostedSend>('/v1/sends', 'POST', body, options)
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
  request<{ setting: number; sends: number }>('/v1/sends/counts', 'GET', undefined, options)
