import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { jsonBody } from '../../shared/http-json.ts'
import { readRecordSessionToken } from '../../shared/record-session.ts'
import type { RecordSpaceMembership } from '../../shared/record-space-membership.ts'
import type { HostedAcknowledgement, HostedNote } from './hosted-notes.ts'
import { type HostedRequestSafety, hostedRefusalError } from './hosted-refusal.ts'
import type { HostedSend } from './hosted-reports.ts'
import type { HostedTaskPresencePair } from './hosted-task-prune.ts'
import type { HostedComment, HostedDocument, HostedTask } from './hosted-tasks.ts'
import { resolveHostedUrl } from './hosted-url.ts'
import { MISSING_HOSTED_URL_REMEDY } from './hosted-write-mode.ts'
import { parseIdentitySetPage } from './identity-set-contract.ts'
import {
  type OperatorWaitingEmailResult,
  operatorWaitingEmailResponseSchema,
} from './operator-waiting-email-contract.ts'
import type {
  HostedPushChange,
  HostedPushOutcome,
  PushableHubChangeTable,
} from './push-contract.ts'

const TEST_REFUSAL = `${PLATFORM_SLUG} task client refuses a real hosted URL unless a stub is injected in tests`
const REMEDY = MISSING_HOSTED_URL_REMEDY
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HOSTED_REQUEST_DEADLINE_MS = 30_000
export type TaskFetch = (input: string, init?: RequestInit) => Promise<Response>

type HostedRequestOptions = {
  baseUrl?: string
  token?: string | null
  fetch?: TaskFetch
  recordSpace?: string | null
  requestDeadlineMs?: number
}

async function hostedFetch(
  input: string,
  init: RequestInit,
  options: HostedRequestOptions,
): Promise<Response> {
  const controller = new AbortController()
  const deadlineMs = options.requestDeadlineMs ?? HOSTED_REQUEST_DEADLINE_MS
  const timeout = setTimeout(() => controller.abort(), deadlineMs)
  const expired = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new Error(`request timed out after ${deadlineMs}ms`)),
      { once: true },
    )
  })
  try {
    return await Promise.race([
      (options.fetch ?? fetch)(input, { ...init, signal: controller.signal }),
      expired,
    ])
  } finally {
    clearTimeout(timeout)
  }
}

export type HostedTaskIdentity = {
  userId: string
  userName?: string | null
  activeSpaceId: string
  memberships: RecordSpaceMembership[]
  capabilities?: {
    projectNoteCounters?: boolean
    targetSpaceNotes?: boolean
    noteTriageStaleness?: boolean
    spaceChanges?: boolean
    spacePush?: boolean
    spacePushTables?: PushableHubChangeTable[]
    spaceIdentitySet?: boolean
  }
}

const SPACE_IDENTITY_SET_REMEDY = 'deploy the hub server at or after the space identity set change'

export function assertSpaceIdentitySet(identity: HostedTaskIdentity) {
  if (identity.capabilities?.spaceIdentitySet !== true)
    throw new Error(
      `hosted hub does not advertise space identity set support; ${SPACE_IDENTITY_SET_REMEDY}`,
    )
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

export function assertNoteTriageStaleness(identity: HostedTaskIdentity) {
  if (identity.capabilities?.noteTriageStaleness !== true)
    throw new Error(
      'hosted hub does not advertise note triage staleness support; run `scripts/deploy/hosted api` and retry',
    )
}

function assertHostedTaskWriteConfigured(options: { baseUrl?: string } = {}) {
  const baseUrl = options.baseUrl ?? resolveHostedUrl()
  if (!baseUrl) throw new Error(`hosted hub is not configured. ${REMEDY}`)
  return baseUrl
}

async function responseObject(
  path: string,
  method: string,
  body?: unknown,
  options: HostedRequestOptions = {},
  safety: HostedRequestSafety = 'probe',
): Promise<{ response: Response; value: Record<string, unknown> }> {
  const baseUrl = assertHostedTaskWriteConfigured(options)
  if (process.env.NODE_ENV === 'test' && !options.fetch) throw new Error(TEST_REFUSAL)
  const token = options.token ?? readRecordSessionToken()
  if (!token)
    throw new Error(
      `record session is absent. Run \`${PLATFORM_SLUG} record sign-in\`, then \`${PLATFORM_SLUG} record doctor\`.`,
    )
  let response: Response
  try {
    response = await hostedFetch(
      `${baseUrl.replace(/\/$/, '')}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(options.recordSpace ? { 'x-record-space': options.recordSpace } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      options,
    )
  } catch (error) {
    throw hostedRefusalError({ cause: error, safety, hostedConfigured: true })
  }
  const url = `${baseUrl.replace(/\/$/, '')}${path}`
  const bodyResult = await jsonBody(response, url)
  const value = bodyResult.ok ? bodyResult.value : null
  if (!bodyResult.ok || !value || typeof value !== 'object' || Array.isArray(value))
    throw hostedRefusalError({
      status: response.status,
      statusText: response.statusText,
      body: value,
      safety,
      hostedConfigured: true,
    })
  return { response, value: value as Record<string, unknown> }
}

async function request<T>(
  path: string,
  method: string,
  body?: unknown,
  options: HostedRequestOptions = {},
  safety: HostedRequestSafety = 'probe',
): Promise<T> {
  const { response, value } = await responseObject(path, method, body, options, safety)
  if (!response.ok)
    throw hostedRefusalError({
      status: response.status,
      statusText: response.statusText,
      body: value,
      safety,
      hostedConfigured: true,
    })
  return value as T
}

class HostedTaskRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const isMissingHostedTask = (cause: unknown) =>
  cause instanceof HostedTaskRequestError && cause.status === 404

export async function hostedGetTask(
  taskId: string,
  options?: Parameters<typeof request>[3],
): Promise<{ task: HostedTask; comments: HostedComment[]; documents: HostedDocument[] }> {
  const { response, value } = await responseObject(
    `/v1/tasks/${encodeURIComponent(taskId)}`,
    'GET',
    undefined,
    options,
  )
  if (!response.ok)
    throw new HostedTaskRequestError(
      response.status,
      hostedRefusalError({
        status: response.status,
        statusText: response.statusText,
        body: value,
        safety: 'probe',
        hostedConfigured: true,
      }).message,
    )
  return value as { task: HostedTask; comments: HostedComment[]; documents: HostedDocument[] }
}

export const hostedCreateTask = (body: unknown, options?: Parameters<typeof request>[3]) =>
  request<HostedTask>('/v1/tasks', 'POST', body, options, 'non-idempotent')
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
    'idempotent',
  )
  if (!response.ok)
    throw hostedRefusalError({
      status: response.status,
      statusText: response.statusText,
      body: value,
      safety: 'idempotent',
      hostedConfigured: true,
    })
  const parsed = operatorWaitingEmailResponseSchema.safeParse(value)
  if (!parsed.success) throw new Error('hosted hub returned an invalid operator waiting email')
  return parsed.data
}
export const hostedCreateDocument = (
  key: string,
  body: unknown,
  options?: Parameters<typeof request>[3],
) =>
  request<HostedDocument>(
    `/v1/tasks/${encodeURIComponent(key)}/documents`,
    'POST',
    body,
    options,
    'non-idempotent',
  )
export async function hostedListTasks(options?: Parameters<typeof request>[3]) {
  type Result = {
    tasks: HostedTask[]
    comments: HostedComment[]
    documents: HostedDocument[]
    statusEvents: import('./hosted-tasks.ts').HostedStatusEvent[]
  }
  const rows = { tasks: [], comments: [], documents: [], statusEvents: [] } as Result
  let cursor: string | null = null
  for (;;) {
    const query = new URLSearchParams()
    if (cursor) query.set('cursor', cursor)
    const page = await request<Result & { cursor: string; more: boolean }>(
      `/v1/tasks?${query}`,
      'GET',
      undefined,
      options,
    )
    rows.tasks.push(...page.tasks)
    rows.comments.push(...page.comments)
    rows.documents.push(...page.documents)
    rows.statusEvents.push(...page.statusEvents)
    if (!page.more) return { ...rows, cursor: page.cursor, more: false }
    if (page.cursor === cursor) throw new Error('hosted task list cursor did not advance')
    cursor = page.cursor
  }
}

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
  }>('/v1/tasks', 'DELETE', { ids, confirmation }, options, 'idempotent')

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
    more?: boolean
  }>(`/v1/tasks?${query}`, 'GET', undefined, options)
}

export type HostedSpaceChange = {
  sequence: number
  table: string
  id: string
  op: 'upsert' | 'delete'
  row?:
    | HostedTask
    | HostedComment
    | HostedDocument
    | import('./hosted-tasks.ts').HostedStatusEvent
    | HostedNote
    | HostedAcknowledgement
    | HostedSend
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

function capabilityFlag(capabilities: unknown, name: string): boolean {
  return (
    typeof capabilities === 'object' &&
    capabilities !== null &&
    (capabilities as Record<string, unknown>)[name] === true
  )
}

export async function hostedIdentitySet(
  table: PushableHubChangeTable,
  options: Parameters<typeof request>[3] & { after?: string | null } = {},
): Promise<{ ids: string[]; more: boolean }> {
  const query = new URLSearchParams({ table })
  if (options.after) query.set('after', options.after)
  return parseIdentitySetPage(
    await request<Record<string, unknown>>(`/v1/changes/ids?${query}`, 'GET', undefined, options),
  )
}

export async function hostedPushChanges(
  body: HostedPushChange[],
  options: Parameters<typeof request>[3] = {},
): Promise<HostedPushOutcome[]> {
  const baseUrl = assertHostedTaskWriteConfigured(options)
  if (process.env.NODE_ENV === 'test' && !options.fetch) throw new Error(TEST_REFUSAL)
  const token = options.token ?? readRecordSessionToken()
  if (!token)
    throw new Error(
      `record session is absent. Run \`${PLATFORM_SLUG} record sign-in\`, then \`${PLATFORM_SLUG} record doctor\`.`,
    )
  const url = `${baseUrl.replace(/\/$/, '')}/v1/changes`
  let response: Response
  try {
    response = await hostedFetch(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(options.recordSpace ? { 'x-record-space': options.recordSpace } : {}),
        },
        body: JSON.stringify(body),
      },
      options,
    )
  } catch (error) {
    throw hostedRefusalError({ cause: error, safety: 'idempotent', hostedConfigured: true })
  }
  const result = await jsonBody(response, url)
  if (!result.ok || !Array.isArray(result.value))
    throw hostedRefusalError({
      status: response.status,
      statusText: response.statusText,
      body: result.ok ? result.value : undefined,
      safety: 'idempotent',
      hostedConfigured: true,
    })
  if (!response.ok)
    throw hostedRefusalError({
      status: response.status,
      statusText: response.statusText,
      body: result.value,
      safety: 'idempotent',
      hostedConfigured: true,
    })
  const outcomes = result.value.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('hosted hub returned a malformed push outcome')
    const row = value as Record<string, unknown>
    if (
      typeof row.id !== 'string' ||
      (row.status !== 'applied' && row.status !== 'duplicate' && row.status !== 'rejected') ||
      (row.status === 'rejected' && typeof row.reason !== 'string') ||
      (row.status !== 'rejected' && row.reason !== undefined && typeof row.reason !== 'string') ||
      (row.status === 'rejected' &&
        (row.adoptedId !== undefined || row.replacedId !== undefined)) ||
      (row.status !== 'rejected' &&
        row.adoptedId !== undefined &&
        (typeof row.adoptedId !== 'string' || !UUID.test(row.adoptedId))) ||
      (row.status !== 'rejected' &&
        row.replacedId !== undefined &&
        (typeof row.replacedId !== 'string' || !UUID.test(row.replacedId)))
    )
      throw new Error('hosted hub returned a malformed push outcome')
    return row as HostedPushOutcome
  })
  const expectedIds = Array.isArray(body)
    ? body.map((value) =>
        value && typeof value === 'object' ? (value as Record<string, unknown>).id : null,
      )
    : []
  const returnedIds = outcomes.map((outcome) => outcome.id)
  if (
    expectedIds.some((id) => typeof id !== 'string') ||
    new Set(returnedIds).size !== returnedIds.length ||
    expectedIds.length !== returnedIds.length ||
    expectedIds.some((id) => !returnedIds.includes(id as string))
  )
    throw new Error('hosted hub returned push outcomes that do not match the requested ids')
  return outcomes
}

type TaskIdentityResult =
  | { unauthorized: true; error: Error }
  | { unauthorized: false; value: Record<string, unknown> }

async function taskIdentityResponse(
  options: Parameters<typeof request>[3] = {},
): Promise<{ response: Response; url: string }> {
  const baseUrl = assertHostedTaskWriteConfigured(options)
  if (process.env.NODE_ENV === 'test' && !options.fetch) throw new Error(TEST_REFUSAL)
  const token = options.token ?? readRecordSessionToken()
  if (!token)
    throw new Error(
      `record session is absent. Run \`${PLATFORM_SLUG} record sign-in\`, then \`${PLATFORM_SLUG} record doctor\`.`,
    )
  const url = `${baseUrl.replace(/\/$/, '')}/v1/tasks/identity`
  let response: Response
  try {
    response = await hostedFetch(
      url,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
      },
      options,
    )
  } catch (error) {
    throw hostedRefusalError({ cause: error, safety: 'probe', hostedConfigured: true })
  }
  return { response, url }
}

async function taskIdentityResult(
  options: Parameters<typeof request>[3] = {},
): Promise<TaskIdentityResult> {
  const { response, url } = await taskIdentityResponse(options)
  const bodyResult = await jsonBody(response, url)
  const value = bodyResult.ok ? bodyResult.value : null
  if (!bodyResult.ok || !value || typeof value !== 'object' || Array.isArray(value))
    throw hostedRefusalError({
      status: response.status,
      statusText: response.statusText,
      body: value,
      safety: 'probe',
      hostedConfigured: true,
    })
  const object = value as Record<string, unknown>
  if (!response.ok) {
    const error = hostedRefusalError({
      status: response.status,
      statusText: response.statusText,
      body: object,
      safety: 'probe',
      hostedConfigured: true,
    })
    if (response.status === 401) return { unauthorized: true, error }
    throw error
  }
  validateTaskIdentityUser(object)
  return { unauthorized: false, value: object }
}

function validateTaskIdentityUser(object: Record<string, unknown>): void {
  if (typeof object.userId !== 'string')
    throw new Error('hosted hub returned a malformed task identity: userId must be a string')
  if (
    object.userName !== undefined &&
    object.userName !== null &&
    typeof object.userName !== 'string'
  )
    throw new Error(
      'hosted hub returned a malformed task identity: userName must be a string or null',
    )
}

export async function hostedTaskIdentity(
  options?: Parameters<typeof request>[3],
): Promise<HostedTaskIdentity> {
  const result = await taskIdentityResult(options)
  if (result.unauthorized) throw result.error
  const value = result.value
  if (!value.activeSpaceId)
    throw new Error('hosted hub has no active space; switch spaces and retry')
  if (!Array.isArray(value.memberships))
    throw new Error('hosted hub returned a malformed task identity: memberships must be an array')
  return {
    userId: value.userId as string,
    userName: (value.userName as string | null | undefined) ?? null,
    activeSpaceId: value.activeSpaceId as string,
    memberships: value.memberships as RecordSpaceMembership[],
    capabilities: {
      projectNoteCounters: capabilityFlag(value.capabilities, 'projectNoteCounters'),
      targetSpaceNotes: capabilityFlag(value.capabilities, 'targetSpaceNotes'),
      noteTriageStaleness: capabilityFlag(value.capabilities, 'noteTriageStaleness'),
      spaceChanges: capabilityFlag(value.capabilities, 'spaceChanges'),
      spacePush: capabilityFlag(value.capabilities, 'spacePush'),
      spaceIdentitySet: capabilityFlag(value.capabilities, 'spaceIdentitySet'),
      spacePushTables:
        typeof value.capabilities === 'object' &&
        value.capabilities !== null &&
        Array.isArray((value.capabilities as Record<string, unknown>).spacePushTables)
          ? ((value.capabilities as Record<string, unknown>)
              .spacePushTables as PushableHubChangeTable[])
          : undefined,
    },
  }
}

export async function hostedSignedInUserId(
  options?: Parameters<typeof request>[3],
): Promise<string | null> {
  const result = await taskIdentityResult(options)
  return result.unauthorized ? null : (result.value.userId as string)
}

export async function hostedSignedInUser(
  options?: Parameters<typeof request>[3],
): Promise<{ id: string; name: string | null } | null> {
  const result = await taskIdentityResult(options)
  return result.unauthorized
    ? null
    : {
        id: result.value.userId as string,
        name: (result.value.userName as string | null | undefined) ?? null,
      }
}
