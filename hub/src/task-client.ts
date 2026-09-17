import { readRecordSessionToken } from '../../shared/record-session.ts'
import type { HostedComment, HostedDocument, HostedTask } from './hosted-tasks.ts'

const TEST_REFUSAL = 'hub task client refuses a real hosted URL unless a stub is injected in tests'
const REMEDY = 'Set HUB_HOSTED_URL and run `orch record doctor`.'
export type TaskFetch = (input: string, init?: RequestInit) => Promise<Response>

export function assertHostedTaskWriteConfigured(options: { baseUrl?: string } = {}) {
  const baseUrl = options.baseUrl ?? process.env.HUB_HOSTED_URL
  if (!baseUrl) throw new Error(`hosted hub is not configured. ${REMEDY}`)
  return baseUrl
}

async function request<T>(
  path: string,
  method: string,
  body?: unknown,
  options: { baseUrl?: string; token?: string | null; fetch?: TaskFetch } = {},
): Promise<T> {
  const baseUrl = assertHostedTaskWriteConfigured(options)
  if (process.env.NODE_ENV === 'test' && !options.fetch) throw new Error(TEST_REFUSAL)
  const token = options.token ?? readRecordSessionToken()
  if (!token)
    throw new Error(
      `record session is absent. Run \`orch record sign-in\`, then \`orch record doctor\`.`,
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
      `hosted hub refused the write (${response.status}): ${String(value?.error ?? 'unknown error')}. ${REMEDY}`,
    )
  return value as T
}

export const hostedCreateTask = (body: unknown, options?: Parameters<typeof request>[3]) =>
  request<HostedTask>('/v1/tasks', 'POST', body, options)
export const hostedPatchTask = (
  key: string,
  body: unknown,
  options?: Parameters<typeof request>[3],
) =>
  request<HostedTask & { status_event?: import('./hosted-tasks.ts').HostedStatusEvent }>(
    `/v1/tasks/${encodeURIComponent(key)}`,
    'PATCH',
    body,
    options,
  )
export const hostedCloseTask = (key: string, options?: Parameters<typeof request>[3]) =>
  request<HostedTask & { status_event?: import('./hosted-tasks.ts').HostedStatusEvent }>(
    `/v1/tasks/${encodeURIComponent(key)}/close`,
    'POST',
    {},
    options,
  )
export const hostedCommentTask = (
  key: string,
  body: string,
  options?: Parameters<typeof request>[3],
) =>
  request<HostedComment>(`/v1/tasks/${encodeURIComponent(key)}/comments`, 'POST', { body }, options)
export const hostedCreateDocument = (
  key: string,
  body: unknown,
  options?: Parameters<typeof request>[3],
) =>
  request<HostedDocument>(`/v1/tasks/${encodeURIComponent(key)}/documents`, 'POST', body, options)
export const hostedPatchDocument = (
  key: string,
  id: string,
  body: unknown,
  options?: Parameters<typeof request>[3],
) =>
  request<HostedDocument>(
    `/v1/tasks/${encodeURIComponent(key)}/documents/${id}`,
    'PATCH',
    body,
    options,
  )
export const hostedDeleteDocument = (
  key: string,
  id: string,
  options?: Parameters<typeof request>[3],
) =>
  request<{ deleted: number }>(
    `/v1/tasks/${encodeURIComponent(key)}/documents/${id}`,
    'DELETE',
    undefined,
    options,
  )

export async function hostedTaskChanges(
  cursor: string | null,
  options?: Parameters<typeof request>[3],
) {
  const query = new URLSearchParams({ includeDeleted: 'true' })
  if (cursor) query.set('cursor', cursor)
  return request<{
    tasks: HostedTask[]
    comments: HostedComment[]
    documents: HostedDocument[]
    statusEvents: import('./hosted-tasks.ts').HostedStatusEvent[]
    cursor: string
  }>(`/v1/tasks?${query}`, 'GET', undefined, options)
}

export const hostedMirrorTasks = (body: unknown, options?: Parameters<typeof request>[3]) =>
  request<{ upserted: number }>('/v1/tasks/mirror', 'PUT', body, options)
export const hostedTaskCounts = (options?: Parameters<typeof request>[3]) =>
  request<Record<string, Array<{ source: string; count: number }>>>(
    '/v1/tasks/counts',
    'GET',
    undefined,
    options,
  )
