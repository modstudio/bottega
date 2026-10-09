import { jsonBody } from '../../shared/http-json.ts'
import { readRecordSessionToken } from '../../shared/record-session.ts'
import type { HostedAcknowledgement, HostedNote } from './hosted-notes.ts'
import type { HostedTask } from './hosted-tasks.ts'
import { HOSTED_UNREACHABLE_REMEDY, MISSING_HOSTED_URL_REMEDY } from './hosted-write-mode.ts'
import {
  assertProjectNoteCounters,
  assertTargetSpaceNotes,
  hostedTaskIdentity,
} from './task-client.ts'

const TEST_REFUSAL = 'hub note client refuses a real hosted URL unless a stub is injected in tests'
const REMEDY = MISSING_HOSTED_URL_REMEDY
const UNREACHABLE_REMEDY = HOSTED_UNREACHABLE_REMEDY
type NoteFetch = (input: string, init?: RequestInit) => Promise<Response>
type Options = { baseUrl?: string; token?: string | null; fetch?: NoteFetch; recordSpace?: string }
async function request<T>(
  path: string,
  method: string,
  body?: unknown,
  options: Options = {},
): Promise<T> {
  if (options.recordSpace) {
    const identity = await hostedTaskIdentity(options)
    if (options.recordSpace !== identity.activeSpaceId) assertTargetSpaceNotes(identity)
  }
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
  if (!bodyResult.ok)
    throw new Error(
      `hosted notes refused the response from ${bodyResult.url} (status ${bodyResult.status}, content type ${bodyResult.contentType}): expected JSON. ${REMEDY}`,
    )
  const value = bodyResult.value as Record<string, unknown> | null
  if (!response.ok)
    throw new Error(
      `hosted hub refused the write (${response.status}): ${String(value?.error ?? 'unknown error')}. ${REMEDY}`,
    )
  return value as T
}
async function assertNoteCapabilities(options?: Options) {
  const identity = await hostedTaskIdentity(options)
  assertProjectNoteCounters(identity)
}
export const hostedCreateNote = async (body: unknown, options?: Options) => {
  await assertNoteCapabilities(options)
  return request<HostedNote>('/v1/notes', 'POST', body, options)
}
export const hostedAcknowledgeNote = (recordId: string, session: string, options?: Options) =>
  request<{
    note: HostedNote
    acknowledgement: HostedAcknowledgement
    alreadyAcknowledged: boolean
  }>(`/v1/notes/${recordId}/acknowledgements`, 'POST', { session }, options)
export const hostedPromoteNote = (recordId: string, task: string | undefined, options?: Options) =>
  request<{ note: HostedNote; task: HostedTask | null }>(
    `/v1/notes/${recordId}/promote`,
    'POST',
    task ? { task } : {},
    options,
  )
export const hostedDropNote = (recordId: string, reason: string, options?: Options) =>
  request<HostedNote>(`/v1/notes/${recordId}/drop`, 'POST', { reason }, options)
export const hostedMergeNotes = (target: string, source: string, options?: Options) =>
  request<{ note: HostedNote; deleted: string }>(
    '/v1/notes/merge',
    'POST',
    { target, source },
    options,
  )
export const hostedReapNotes = (body: unknown, options?: Options) =>
  request<{ marked: number; deleted: number }>('/v1/notes/reap', 'POST', body, options)
export async function hostedNoteChanges(cursor: string | null, options?: Options) {
  await assertNoteCapabilities(options)
  const query = new URLSearchParams({ includeDeleted: 'true' })
  if (cursor) query.set('cursor', cursor)
  return request<{
    notes: HostedNote[]
    acknowledgements: HostedAcknowledgement[]
    projectCounters: Array<{ project: string; next: number }>
    cursor: string
  }>(`/v1/notes?${query}`, 'GET', undefined, options)
}
export const hostedMirrorNotes = async (body: unknown, options?: Options) => {
  await assertNoteCapabilities(options)
  return request<{ upserted: number; noteIds: Array<{ number: number; id: string }> }>(
    '/v1/notes/mirror',
    'PUT',
    body,
    options,
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
