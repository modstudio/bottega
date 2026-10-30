import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { jsonBody } from '../../shared/http-json.ts'
import { readRecordSessionToken } from '../../shared/record-session.ts'
import type { HostedAcknowledgement, HostedNote, PromoteNoteInput } from './hosted-notes.ts'
import { type HostedRequestSafety, hostedRefusalError } from './hosted-refusal.ts'
import type { HostedComment, HostedTask } from './hosted-tasks.ts'
import { resolveHostedUrl } from './hosted-url.ts'
import { MISSING_HOSTED_URL_REMEDY } from './hosted-write-mode.ts'
import {
  assertNoteTriageStaleness,
  assertProjectNoteCounters,
  assertTargetSpaceNotes,
  hostedTaskIdentity,
} from './task-client.ts'

const TEST_REFUSAL = `${PLATFORM_SLUG} note client refuses a real hosted URL unless a stub is injected in tests`
const REMEDY = MISSING_HOSTED_URL_REMEDY
type NoteFetch = (input: string, init?: RequestInit) => Promise<Response>
type Options = { baseUrl?: string; token?: string | null; fetch?: NoteFetch; recordSpace?: string }
class HostedNoteRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
export const isMissingHostedNote = (cause: unknown) =>
  cause instanceof HostedNoteRequestError && cause.status === 404
async function request<T>(
  path: string,
  method: string,
  body?: unknown,
  options: Options = {},
  safety: HostedRequestSafety = 'probe',
): Promise<T> {
  if (options.recordSpace) {
    const identity = await hostedTaskIdentity(options)
    if (options.recordSpace !== identity.activeSpaceId) assertTargetSpaceNotes(identity)
  }
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
        ...(options.recordSpace ? { 'x-record-space': options.recordSpace } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    throw hostedRefusalError({ cause: error, safety, hostedConfigured: true })
  }
  const url = `${baseUrl.replace(/\/$/, '')}${path}`
  const bodyResult = await jsonBody(response, url)
  if (!bodyResult.ok)
    throw hostedRefusalError({
      status: response.status,
      statusText: response.statusText,
      safety,
      hostedConfigured: true,
    })
  const value = bodyResult.value as Record<string, unknown> | null
  if (!response.ok)
    throw new HostedNoteRequestError(
      response.status,
      hostedRefusalError({
        status: response.status,
        statusText: response.statusText,
        body: value,
        safety,
        hostedConfigured: true,
      }).message,
    )
  return value as T
}
async function assertNoteCapabilities(options?: Options) {
  const identity = await hostedTaskIdentity(options)
  assertProjectNoteCounters(identity)
}
export const hostedCreateNote = async (body: unknown, options?: Options) => {
  await assertNoteCapabilities(options)
  return request<HostedNote>('/v1/notes', 'POST', body, options, 'non-idempotent')
}
export const hostedPromoteNote = (recordId: string, input: PromoteNoteInput, options?: Options) =>
  request<{ note: HostedNote; task: HostedTask | null; comment: HostedComment | null }>(
    `/v1/notes/${recordId}/promote`,
    'POST',
    input,
    options,
    'non-idempotent',
  )
export const hostedReapNotes = async (body: unknown, options?: Options) => {
  const identity = await hostedTaskIdentity(options)
  assertNoteTriageStaleness(identity)
  return request<{
    marked: number
    annotated: number
    restored: number
    deleted: number
    staleIds: string[]
    annotatedIds: string[]
    restoredIds: string[]
    deletedIds: string[]
  }>('/v1/notes/reap', 'POST', body, options, 'idempotent')
}
export async function hostedNoteChanges(cursor: string | null, options?: Options) {
  await assertNoteCapabilities(options)
  const query = new URLSearchParams({ includeDeleted: 'true' })
  if (cursor) query.set('cursor', cursor)
  return request<{
    notes: HostedNote[]
    acknowledgements: HostedAcknowledgement[]
    projectCounters: Array<{ project: string; next: number }>
    cursor: string
    more?: boolean
  }>(`/v1/notes?${query}`, 'GET', undefined, options)
}
export const hostedMirrorNotes = async (body: unknown, options?: Options) => {
  await assertNoteCapabilities(options)
  return request<{ upserted: number; noteIds: Array<{ number: number; id: string }> }>(
    '/v1/notes/mirror',
    'PUT',
    body,
    options,
    'idempotent',
  )
}
export const hostedNoteCounts = (options?: Options) =>
  request<{ note: number; note_acknowledgement: number }>(
    '/v1/notes/counts',
    'GET',
    undefined,
    options,
  )
export const hostedGetNote = (recordId: string, options?: Options) =>
  request<HostedNote>(`/v1/notes/${recordId}`, 'GET', undefined, options)
export type NoteClientOptions = Options
