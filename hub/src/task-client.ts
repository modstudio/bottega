import { readRecordSessionToken } from '../../shared/record-session.ts'
import type { RecordSpaceMembership } from '../../shared/record-space-membership.ts'
import type { HostedTaskPresencePair } from './hosted-task-prune.ts'
import type { HostedComment, HostedDocument, HostedTask } from './hosted-tasks.ts'

const TEST_REFUSAL = 'hub task client refuses a real hosted URL unless a stub is injected in tests'
const REMEDY = 'Set HUB_HOSTED_URL and run `orch record doctor`.'
export type TaskFetch = (input: string, init?: RequestInit) => Promise<Response>

export type HostedTaskIdentity = {
  userId: string
  activeSpaceId: string
  memberships: RecordSpaceMembership[]
}

export function assertHostedTaskWriteConfigured(options: { baseUrl?: string } = {}) {
  const baseUrl = options.baseUrl ?? process.env.HUB_HOSTED_URL
  if (!baseUrl) throw new Error(`hosted hub is not configured. ${REMEDY}`)
  return baseUrl
}

async function responseObject(
  path: string,
  method: string,
  body?: unknown,
  options: { baseUrl?: string; token?: string | null; fetch?: TaskFetch } = {},
  allowUnauthorized = false,
): Promise<{ response: Response; value: Record<string, unknown> }> {
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
  const url = `${baseUrl.replace(/\/$/, '')}${path}`
  if (allowUnauthorized && response.status === 401) return { response, value: {} }
  const contentType = response.headers.get('content-type') ?? 'missing'
  const isJson = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(contentType)
  const value = isJson
    ? ((await response.json().catch(() => null)) as Record<string, unknown> | null)
    : null
  if (!isJson || !value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(
      `hosted hub refused the response from ${url} (status ${response.status}, content type ${contentType}): expected a JSON object. ${REMEDY}`,
    )
  return { response, value }
}

async function request<T>(
  path: string,
  method: string,
  body?: unknown,
  options: { baseUrl?: string; token?: string | null; fetch?: TaskFetch } = {},
): Promise<T> {
  const { response, value } = await responseObject(path, method, body, options)
  if (!response.ok && path === '/v1/tasks/identity' && response.status === 404)
    throw new Error(
      `hosted hub does not serve the task identity route (404): ${String(
        value.error ?? 'unknown error',
      )}${value.remedy ? `. ${String(value.remedy)}` : ''}; redeploy the hosted hub from this revision`,
    )
  if (!response.ok)
    throw new Error(
      `hosted hub refused the request (${response.status}): ${String(value.error ?? 'unknown error')}${
        value.remedy ? `. ${String(value.remedy)}` : ''
      }`,
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

export const hostedListTasks = (options?: Parameters<typeof request>[3]) =>
  request<{
    tasks: HostedTask[]
    comments: HostedComment[]
    documents: HostedDocument[]
    statusEvents: import('./hosted-tasks.ts').HostedStatusEvent[]
    cursor: string
  }>('/v1/tasks', 'GET', undefined, options)

export const hostedTaskPresence = (
  pairs: HostedTaskPresencePair[],
  options?: Parameters<typeof request>[3],
) =>
  request<{
    present: HostedTaskPresencePair[]
    refused: Array<HostedTaskPresencePair & { reason: 'not-a-member' }>
  }>('/v1/tasks/presence', 'POST', { pairs }, options)

export const hostedDeleteTasks = (
  ids: string[],
  confirmation: number | undefined,
  options?: Parameters<typeof request>[3],
) =>
  request<{ tasks: number; comments: number; documents: number; statusEvents: number }>(
    '/v1/tasks',
    'DELETE',
    { ids, confirmation },
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
  request<{
    upserted: number
    adoptions?: import('./hosted-tasks.ts').MirrorAdoption[]
  }>('/v1/tasks/mirror', 'PUT', body, options)
export async function hostedTaskIdentity(
  options?: Parameters<typeof request>[3],
): Promise<HostedTaskIdentity> {
  const value = await request<HostedTaskIdentity & { activeSpaceId: string | null }>(
    '/v1/tasks/identity',
    'GET',
    undefined,
    options,
  )
  if (!value.activeSpaceId)
    throw new Error('hosted hub has no active space; switch spaces and retry')
  if (!Array.isArray(value.memberships))
    throw new Error('hosted hub returned a malformed task identity: memberships must be an array')
  if (typeof value.userId !== 'string')
    throw new Error('hosted hub returned a malformed task identity: userId must be a string')
  return {
    userId: value.userId,
    activeSpaceId: value.activeSpaceId,
    memberships: value.memberships,
  }
}

export async function hostedSignedInUserId(
  options?: Parameters<typeof request>[3],
): Promise<string | null> {
  const { response, value } = await responseObject(
    '/v1/tasks/identity',
    'GET',
    undefined,
    options,
    true,
  )
  if (response.status === 401) return null
  if (!response.ok)
    throw new Error(
      `hosted hub refused the request (${response.status}): ${String(value.error ?? 'unknown error')}${
        value.remedy ? `. ${String(value.remedy)}` : ''
      }`,
    )
  if (typeof value.userId !== 'string')
    throw new Error('hosted hub returned a malformed task identity: userId must be a string')
  return value.userId
}
export const hostedTaskCounts = (options?: Parameters<typeof request>[3]) =>
  request<Record<string, Array<{ source: string; count: number }>>>(
    '/v1/tasks/counts',
    'GET',
    undefined,
    options,
  )
