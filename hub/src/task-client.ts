import { diagnosticUrl, jsonBody } from '../../shared/http-json.ts'
import { readRecordSessionToken } from '../../shared/record-session.ts'
import type { RecordSpaceMembership } from '../../shared/record-space-membership.ts'
import type { HostedTaskPresencePair } from './hosted-task-prune.ts'
import type { HostedComment, HostedDocument, HostedTask } from './hosted-tasks.ts'
import { HOSTED_UNREACHABLE_REMEDY, MISSING_HOSTED_URL_REMEDY } from './hosted-write-mode.ts'
import {
  type OperatorWaitingEmailResult,
  operatorWaitingEmailResponseSchema,
} from './operator-waiting-email-contract.ts'

const TEST_REFUSAL = 'hub task client refuses a real hosted URL unless a stub is injected in tests'
const REMEDY = MISSING_HOSTED_URL_REMEDY
const UNREACHABLE_REMEDY = HOSTED_UNREACHABLE_REMEDY
export type TaskFetch = (input: string, init?: RequestInit) => Promise<Response>

export type HostedTaskIdentity = {
  userId: string
  activeSpaceId: string
  memberships: RecordSpaceMembership[]
}

function assertHostedTaskWriteConfigured(options: { baseUrl?: string } = {}) {
  const baseUrl = options.baseUrl ?? process.env.HUB_HOSTED_URL
  if (!baseUrl) throw new Error(`hosted hub is not configured. ${REMEDY}`)
  return baseUrl
}

async function responseObject(
  path: string,
  method: string,
  body?: unknown,
  options: { baseUrl?: string; token?: string | null; fetch?: TaskFetch } = {},
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
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    throw new Error(`hosted hub is unreachable: ${(error as Error).message}. ${UNREACHABLE_REMEDY}`)
  }
  const url = `${baseUrl.replace(/\/$/, '')}${path}`
  const bodyResult = await jsonBody(response, url)
  const value = bodyResult.ok ? bodyResult.value : null
  if (!bodyResult.ok || !value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(
      `hosted hub refused the response from ${bodyResult.ok ? diagnosticUrl(url) : bodyResult.url} (status ${response.status}, content type ${bodyResult.ok ? (response.headers.get('content-type') ?? 'missing') : bodyResult.contentType}): expected a JSON object. ${REMEDY}`,
    )
  return { response, value: value as Record<string, unknown> }
}

async function request<T>(
  path: string,
  method: string,
  body?: unknown,
  options: { baseUrl?: string; token?: string | null; fetch?: TaskFetch } = {},
): Promise<T> {
  const { response, value } = await responseObject(path, method, body, options)
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
export const hostedCreateOperatorWaitingEmail = (
  body: unknown,
  options?: Parameters<typeof request>[3],
) => operatorWaitingEmailRequest(body, options)

async function operatorWaitingEmailRequest(
  body: unknown,
  options?: Parameters<typeof request>[3],
): Promise<OperatorWaitingEmailResult> {
  const { response, value } = await responseObject(
    '/v1/operator-waiting-emails',
    'POST',
    body,
    options,
  )
  if (!response.ok)
    throw new Error(
      `hosted hub refused the request (${response.status}): ${String(value.error ?? 'unknown error')}`,
    )
  const parsed = operatorWaitingEmailResponseSchema.safeParse(value)
  if (!parsed.success) throw new Error('hosted hub returned an invalid operator waiting email')
  return parsed.data
}
export const hostedPatchTask = (
  key: string,
  body: unknown,
  options?: Parameters<typeof request>[3],
) =>
  request<
    HostedTask & {
      status_event?: import('./hosted-tasks.ts').HostedStatusEvent
    }
  >(`/v1/tasks/${encodeURIComponent(key)}`, 'PATCH', body, options)
export const hostedCloseTask = (key: string, options?: Parameters<typeof request>[3]) =>
  request<
    HostedTask & {
      status_event?: import('./hosted-tasks.ts').HostedStatusEvent
    }
  >(`/v1/tasks/${encodeURIComponent(key)}/close`, 'POST', {}, options)
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
  request<{
    tasks: number
    comments: number
    documents: number
    statusEvents: number
  }>('/v1/tasks', 'DELETE', { ids, confirmation }, options)

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

type TaskIdentityResult =
  | { unauthorized: true }
  | { unauthorized: false; value: Record<string, unknown> }

async function taskIdentityResponse(
  options: Parameters<typeof request>[3] = {},
): Promise<{ response: Response; url: string }> {
  const baseUrl = assertHostedTaskWriteConfigured(options)
  if (process.env.NODE_ENV === 'test' && !options.fetch) throw new Error(TEST_REFUSAL)
  const token = options.token ?? readRecordSessionToken()
  if (!token)
    throw new Error(
      `record session is absent. Run \`orch record sign-in\`, then \`orch record doctor\`.`,
    )
  const url = `${baseUrl.replace(/\/$/, '')}/v1/tasks/identity`
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    })
  } catch (error) {
    throw new Error(`hosted hub is unreachable: ${(error as Error).message}. ${UNREACHABLE_REMEDY}`)
  }
  return { response, url }
}

async function taskIdentityResult(
  options: Parameters<typeof request>[3] = {},
): Promise<TaskIdentityResult> {
  const { response, url } = await taskIdentityResponse(options)
  if (response.status === 401) return { unauthorized: true }
  const bodyResult = await jsonBody(response, url)
  const value = bodyResult.ok ? bodyResult.value : null
  if (!bodyResult.ok || !value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(
      `hosted hub refused the response from ${bodyResult.ok ? diagnosticUrl(url) : bodyResult.url} (status ${response.status}, content type ${bodyResult.ok ? (response.headers.get('content-type') ?? 'missing') : bodyResult.contentType}): expected a JSON object. ${REMEDY}`,
    )
  const object = value as Record<string, unknown>
  if (response.status === 404)
    throw new Error(
      `hosted hub does not serve the task identity route (404): ${String(
        object.error ?? 'unknown error',
      )}${object.remedy ? `. ${String(object.remedy)}` : ''}; redeploy the hosted hub from this revision`,
    )
  if (!response.ok)
    throw new Error(
      `hosted hub refused the request (${response.status}): ${String(object.error ?? 'unknown error')}${
        object.remedy ? `. ${String(object.remedy)}` : ''
      }`,
    )
  if (typeof object.userId !== 'string')
    throw new Error('hosted hub returned a malformed task identity: userId must be a string')
  return { unauthorized: false, value: object }
}

export async function hostedTaskIdentity(
  options?: Parameters<typeof request>[3],
): Promise<HostedTaskIdentity> {
  const result = await taskIdentityResult(options)
  if (result.unauthorized) throw new Error('hosted hub refused the request (401): unknown error')
  const value = result.value
  if (!value.activeSpaceId)
    throw new Error('hosted hub has no active space; switch spaces and retry')
  if (!Array.isArray(value.memberships))
    throw new Error('hosted hub returned a malformed task identity: memberships must be an array')
  return {
    userId: value.userId as string,
    activeSpaceId: value.activeSpaceId as string,
    memberships: value.memberships as RecordSpaceMembership[],
  }
}

export async function hostedSignedInUserId(
  options?: Parameters<typeof request>[3],
): Promise<string | null> {
  const result = await taskIdentityResult(options)
  return result.unauthorized ? null : (result.value.userId as string)
}
export const hostedTaskCounts = (options?: Parameters<typeof request>[3]) =>
  request<Record<string, Array<{ source: string; count: number }>>>(
    '/v1/tasks/counts',
    'GET',
    undefined,
    options,
  )
