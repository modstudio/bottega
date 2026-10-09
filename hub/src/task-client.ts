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
  capabilities?: {
    targetSpaceTaskMirror?: boolean
    targetSpaceIntervalEvidence?: boolean
    intervalRecordId?: boolean
    dayRecordId?: boolean
    projectNoteCounters?: boolean
    targetSpaceNotes?: boolean
    spaceChanges?: boolean
  }
}

const TARGET_SPACE_MIRROR_REMEDY =
  'deploy the hub server at or after the target-space task mirror change'

export function assertTargetSpaceTaskMirror(identity: HostedTaskIdentity) {
  if (identity.capabilities?.targetSpaceTaskMirror !== true)
    throw new Error(
      `hosted hub does not advertise target-space task mirror support; ${TARGET_SPACE_MIRROR_REMEDY}`,
    )
}

const TARGET_SPACE_INTERVAL_REMEDY =
  'deploy the hub server at or after the target-space interval evidence change'

export function assertTargetSpaceIntervalEvidence(identity: HostedTaskIdentity) {
  if (identity.capabilities?.targetSpaceIntervalEvidence !== true)
    throw new Error(
      `hosted hub does not advertise target-space interval evidence support; ${TARGET_SPACE_INTERVAL_REMEDY}`,
    )
}

const INTERVAL_RECORD_ID_REMEDY =
  'deploy the hub server at or after the interval UUID identity change'

export function assertIntervalRecordId(identity: HostedTaskIdentity) {
  if (identity.capabilities?.intervalRecordId !== true)
    throw new Error(
      `hosted hub does not advertise interval record id support; ${INTERVAL_RECORD_ID_REMEDY}`,
    )
}

const DAY_RECORD_ID_REMEDY = 'deploy the hub server at or after the day UUID identity change'

export function assertDayRecordId(identity: HostedTaskIdentity) {
  if (identity.capabilities?.dayRecordId !== true)
    throw new Error(`hosted hub does not advertise day record id support; ${DAY_RECORD_ID_REMEDY}`)
}

const PROJECT_NOTE_COUNTERS_REMEDY =
  'deploy the hub server at or after the per-project note counter change'

export function assertProjectNoteCounters(identity: HostedTaskIdentity) {
  if (identity.capabilities?.projectNoteCounters !== true)
    throw new Error(
      `hosted hub does not advertise per-project note counter support; ${PROJECT_NOTE_COUNTERS_REMEDY}`,
    )
}

const TARGET_SPACE_NOTES_REMEDY = 'deploy the hub server at or after the target-space notes change'

export function assertTargetSpaceNotes(identity: HostedTaskIdentity) {
  if (identity.capabilities?.targetSpaceNotes !== true)
    throw new Error(
      `hosted hub does not advertise target-space note support; ${TARGET_SPACE_NOTES_REMEDY}`,
    )
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
  options: {
    baseUrl?: string
    token?: string | null
    fetch?: TaskFetch
    recordSpace?: string | null
  } = {},
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
        ...(options.recordSpace ? { 'x-record-space': options.recordSpace } : {}),
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
  options: {
    baseUrl?: string
    token?: string | null
    fetch?: TaskFetch
    recordSpace?: string | null
  } = {},
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

export type HostedSpaceChange = {
  sequence: number
  table: string
  id: string
  op: 'upsert' | 'delete'
  row?: HostedTask | HostedComment | HostedDocument | import('./hosted-tasks.ts').HostedStatusEvent
}

export type HostedSpaceChangePage = {
  head: number
  oldest: number | null
  next: number
  more: boolean
  resetRequired: boolean
  changes: HostedSpaceChange[]
}

type HostedSpaceChangeOptions = Parameters<typeof request>[3] & { limit?: number; tables: string }

function malformedChangePage(detail: string) {
  return new Error(`hosted change page is malformed: ${detail}`)
}

function nonNegativeSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw malformedChangePage(`${name} must be a non-negative safe integer`)
  return value
}

function oldestField(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw malformedChangePage('oldest must be a non-negative safe integer or null')
  return value
}

function booleanField(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw malformedChangePage(`${name} must be a boolean`)
  return value
}

function parseHostedSpaceChange(
  value: unknown,
  index: number,
  tables: ReadonlySet<string>,
): HostedSpaceChange {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw malformedChangePage(`changes[${index}] must be an object`)
  const change = value as Record<string, unknown>
  const sequence = nonNegativeSafeInteger(change.sequence, `changes[${index}].sequence`)
  if (typeof change.table !== 'string' || !tables.has(change.table))
    throw malformedChangePage(`changes[${index}].table is not in the requested set`)
  if (change.op !== 'upsert' && change.op !== 'delete')
    throw malformedChangePage(`changes[${index}].op must be upsert or delete`)
  if (typeof change.id !== 'string' || change.id === '')
    throw malformedChangePage(`changes[${index}].id is required`)
  if (change.op === 'delete') {
    if ('row' in change && change.row !== undefined)
      throw malformedChangePage(`changes[${index}] delete must not include a row`)
    return { sequence, table: change.table, id: change.id, op: 'delete' }
  }
  const row = change.row
  if (row === null || typeof row !== 'object' || Array.isArray(row))
    throw malformedChangePage(`changes[${index}] upsert must include a row`)
  if ((row as { id?: unknown }).id !== change.id)
    throw malformedChangePage(`changes[${index}] row id must equal the change id`)
  return {
    sequence,
    table: change.table,
    id: change.id,
    op: 'upsert',
    row: row as HostedSpaceChange['row'],
  }
}

function assertFollowChangeSequences(
  changes: readonly HostedSpaceChange[],
  after: number,
  next: number,
) {
  let previous: number | undefined
  for (const [index, change] of changes.entries()) {
    const { sequence } = change
    if (sequence <= after)
      throw malformedChangePage(
        `changes[${index}].sequence ${sequence} is not greater than after ${after}`,
      )
    if (sequence > next)
      throw malformedChangePage(`changes[${index}].sequence ${sequence} is above next ${next}`)
    if (previous !== undefined && sequence <= previous)
      throw malformedChangePage(
        `changes[${index}].sequence ${sequence} does not increase from changes[${index - 1}].sequence ${previous}`,
      )
    previous = sequence
  }
}

function parseHostedSpaceChangePage(
  value: Record<string, unknown>,
  after: number,
  tables: ReadonlySet<string>,
): HostedSpaceChangePage {
  const head = nonNegativeSafeInteger(value.head, 'head')
  const next = nonNegativeSafeInteger(value.next, 'next')
  const oldest = oldestField(value.oldest)
  const more = booleanField(value.more, 'more')
  const resetRequired = booleanField(value.resetRequired, 'resetRequired')
  if (!Array.isArray(value.changes)) throw malformedChangePage('changes must be an array')
  if (resetRequired) {
    if (value.changes.length)
      throw malformedChangePage('resetRequired page must not include changes')
    return { head, oldest, next, more, resetRequired, changes: [] }
  }
  if (next < after) throw malformedChangePage(`next ${next} is below after ${after}`)
  if (next > head) throw malformedChangePage(`next ${next} is above head ${head}`)
  if (more && next <= after)
    throw malformedChangePage(`more is true but next ${next} is not greater than after ${after}`)
  const changes = value.changes.map((change, index) =>
    parseHostedSpaceChange(change, index, tables),
  )
  assertFollowChangeSequences(changes, after, next)
  return { head, oldest, next, more, resetRequired, changes }
}

export async function hostedSpaceChanges(after: number, options: HostedSpaceChangeOptions) {
  const query = new URLSearchParams({
    after: String(after),
    tables: options.tables,
  })
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  const page = await request<Record<string, unknown>>(
    `/v1/changes?${query}`,
    'GET',
    undefined,
    options,
  )
  return parseHostedSpaceChangePage(page, after, new Set(options.tables.split(',')))
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
    capabilities: {
      targetSpaceTaskMirror:
        typeof value.capabilities === 'object' &&
        value.capabilities !== null &&
        (value.capabilities as Record<string, unknown>).targetSpaceTaskMirror === true,
      targetSpaceIntervalEvidence:
        typeof value.capabilities === 'object' &&
        value.capabilities !== null &&
        (value.capabilities as Record<string, unknown>).targetSpaceIntervalEvidence === true,
      intervalRecordId:
        typeof value.capabilities === 'object' &&
        value.capabilities !== null &&
        (value.capabilities as Record<string, unknown>).intervalRecordId === true,
      dayRecordId:
        typeof value.capabilities === 'object' &&
        value.capabilities !== null &&
        (value.capabilities as Record<string, unknown>).dayRecordId === true,
      projectNoteCounters:
        typeof value.capabilities === 'object' &&
        value.capabilities !== null &&
        (value.capabilities as Record<string, unknown>).projectNoteCounters === true,
      targetSpaceNotes:
        typeof value.capabilities === 'object' &&
        value.capabilities !== null &&
        (value.capabilities as Record<string, unknown>).targetSpaceNotes === true,
      spaceChanges:
        typeof value.capabilities === 'object' &&
        value.capabilities !== null &&
        (value.capabilities as Record<string, unknown>).spaceChanges === true,
    },
  }
}

export async function hostedSignedInUserId(
  options?: Parameters<typeof request>[3],
): Promise<string | null> {
  const result = await taskIdentityResult(options)
  return result.unauthorized ? null : (result.value.userId as string)
}
export const hostedTaskCounts = (targetSpaceId: string, options?: Parameters<typeof request>[3]) =>
  request<Record<string, Array<{ source: string; count: number }>>>(
    '/v1/tasks/counts',
    'GET',
    undefined,
    { ...options, recordSpace: targetSpaceId },
  )
