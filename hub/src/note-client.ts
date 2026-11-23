import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { RECORD_IDENTITY_MEMO_MAX_AGE_MS } from '../../shared/config-read-memo.ts'
import { jsonBody } from '../../shared/http-json.ts'
import type { NoteAnchorWire } from '../../shared/note-anchor.ts'
import { processMemo } from '../../shared/process-memo.ts'
import type { HostedAcknowledgement, HostedNote, PromoteNoteInput } from './hosted-notes.ts'
import { type HostedRequestSafety, hostedRefusalError } from './hosted-refusal.ts'
import {
  type HostedOutsideNoteBody,
  type HostedSessionMethod,
  sendHostedOutsideNoteRequest,
  sendHostedSessionRequest,
} from './hosted-session-send.ts'
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
export type NoteWriteOptions = Omit<Options, 'recordSpace'> & { recordSpace: string }
export type NoteReadOptions = Omit<Options, 'recordSpace'> & { recordSpace: string }
type NoteIdentity = Awaited<ReturnType<typeof hostedTaskIdentity>>
type NoteIdentityMemo = ReturnType<typeof processMemo<NoteIdentity>>
const defaultIdentityMemos = new Map<string, NoteIdentityMemo>()
const transportIdentityMemos = new WeakMap<NoteFetch, Map<string, NoteIdentityMemo>>()

export function hostedNoteIdentity(options: Options = {}): Promise<NoteIdentity> {
  const memos = options.fetch
    ? (transportIdentityMemos.get(options.fetch) ??
      (() => {
        const created = new Map<string, NoteIdentityMemo>()
        transportIdentityMemos.set(options.fetch!, created)
        return created
      })())
    : defaultIdentityMemos
  const key = JSON.stringify([options.baseUrl ?? null, options.token ?? null])
  const existing = memos.get(key)
  if (existing) return existing.get()
  const created = processMemo(() => hostedTaskIdentity(options), {
    maxAgeMs: RECORD_IDENTITY_MEMO_MAX_AGE_MS,
  })
  memos.set(key, created)
  return created.get()
}
class HostedNoteRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
export const isMissingHostedNote = (cause: unknown) =>
  cause instanceof HostedNoteRequestError && cause.status === 404
async function requestValue<T>(url: string, response: Response, safety: HostedRequestSafety) {
  const bodyResult = await jsonBody(response, url)
  if (!bodyResult.ok)
    throw hostedRefusalError({
      status: response.status,
      statusText: response.statusText,
      safety,
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
      }).message,
    )
  return value as T
}

function requestSetup(options: Options) {
  if (options.recordSpace) {
    return hostedNoteIdentity(options).then((identity) => {
      if (options.recordSpace !== identity.activeSpaceId) assertTargetSpaceNotes(identity)
    })
  }
  return Promise.resolve()
}

function requestContext(path: string, options: Options) {
  const baseUrl = options.baseUrl ?? resolveHostedUrl()
  if (!baseUrl) throw new Error(`hosted hub is not configured. ${REMEDY}`)
  if (process.env.NODE_ENV === 'test' && !options.fetch) throw new Error(TEST_REFUSAL)
  return {
    baseUrl,
    url: `${baseUrl.replace(/\/$/, '')}${path}`,
    fetch: options.fetch ?? fetch,
  }
}

async function request<T>(path: string, options: Options = {}): Promise<T> {
  await requestSetup(options)
  const { baseUrl, url, fetch: requestFetch } = requestContext(path, options)
  const response = await sendHostedSessionRequest({
    origin: baseUrl,
    url,
    method: 'GET',
    token: options.token,
    recordSpace: options.recordSpace,
    safety: 'probe',
    fetch: requestFetch,
  })
  return requestValue<T>(url, response, 'probe')
}

async function writeRequest<T>(
  path: string,
  method: Exclude<HostedSessionMethod, 'GET'>,
  body: unknown,
  options: NoteWriteOptions,
  safety: HostedRequestSafety,
): Promise<T> {
  await requestSetup(options)
  const { baseUrl, url, fetch: requestFetch } = requestContext(path, options)
  const response = await sendHostedSessionRequest({
    origin: baseUrl,
    url,
    method,
    body,
    token: options.token,
    recordSpace: options.recordSpace,
    safety,
    fetch: requestFetch,
  })
  return requestValue<T>(url, response, safety)
}
async function assertNoteCapabilities(options?: Options) {
  const identity = await hostedNoteIdentity(options)
  assertProjectNoteCounters(identity)
}
export const hostedCreateNote = async (body: unknown, options: NoteWriteOptions) => {
  await assertNoteCapabilities(options)
  return writeRequest<HostedNote>('/v1/notes', 'POST', body, options, 'non-idempotent')
}
export const hostedPromoteNote = (
  recordId: string,
  input: PromoteNoteInput,
  options: NoteWriteOptions,
) =>
  writeRequest<{ note: HostedNote; task: HostedTask | null; comment: HostedComment | null }>(
    `/v1/notes/${recordId}/promote`,
    'POST',
    input,
    options,
    'non-idempotent',
  )
export const hostedReapNotes = async (body: unknown, options: NoteWriteOptions) => {
  const identity = await hostedNoteIdentity(options)
  assertNoteTriageStaleness(identity)
  return writeRequest<{
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
  }>(`/v1/notes?${query}`, options)
}
export const hostedMirrorNotes = async (body: unknown, options: NoteWriteOptions) => {
  await assertNoteCapabilities(options)
  return writeRequest<{
    upserted: number
    noteIds: Array<{ number: number; id: string }>
    skippedHidden: string[]
  }>('/v1/notes/mirror', 'PUT', body, options, 'idempotent')
}
export const hostedNoteCounts = (options?: Options) =>
  request<{ note: number; note_acknowledgement: number }>('/v1/notes/counts', options)
const normalizeHostedNote = (row: HostedNote & { project_id?: string | null }): HostedNote => ({
  ...row,
  projectId: row.projectId ?? row.project_id ?? null,
})
export const hostedGetNote = (recordId: string, options: NoteReadOptions) =>
  request<HostedNote & { project_id?: string | null }>(`/v1/notes/${recordId}`, options).then(
    normalizeHostedNote,
  )
export async function hostedListNotes(
  filters: { project?: string; stale?: boolean; actionable?: boolean },
  options: NoteReadOptions,
) {
  await hostedNoteIdentity(options)
  const query = new URLSearchParams()
  if (filters.project) query.set('project', filters.project)
  if (filters.stale !== undefined) query.set('stale', String(filters.stale))
  if (filters.actionable !== undefined) query.set('actionable', String(filters.actionable))
  const notes: HostedNote[] = []
  const acknowledgements: HostedAcknowledgement[] = []
  let cursor: string | undefined
  for (;;) {
    const pageQuery = new URLSearchParams(query)
    if (cursor) pageQuery.set('cursor', cursor)
    const page = await request<{
      notes: HostedNote[]
      acknowledgements: HostedAcknowledgement[]
      cursor: string
      more?: boolean
    }>(`/v1/notes?${pageQuery}`, options)
    notes.push(...page.notes.map(normalizeHostedNote))
    acknowledgements.push(...page.acknowledgements)
    if (!page.more) return { notes, acknowledgements }
    cursor = page.cursor
  }
}
export type OutsideNote = {
  id: string
  number: number
  project: string
  text: string
  area: string | null
  anchors: NoteAnchorWire[]
  sightings: number
  created_at: string
}
export const hostedCreateOutsideNote = (body: HostedOutsideNoteBody, options?: Options) =>
  outsideNoteRequest(body, options)
export const hostedListOutsideNotes = (project: string, options?: Options) =>
  request<OutsideNote[]>(`/v1/notes/outside?${new URLSearchParams({ project })}`, options)
export type NoteClientOptions = Options

async function outsideNoteRequest(body: HostedOutsideNoteBody, options: Options = {}) {
  const { baseUrl, url, fetch: requestFetch } = requestContext('/v1/notes/outside', options)
  const response = await sendHostedOutsideNoteRequest({
    origin: baseUrl,
    url,
    body,
    token: options.token,
    safety: 'non-idempotent',
    fetch: requestFetch,
  })
  return requestValue<{ id: string; number: number; project: string }>(
    url,
    response,
    'non-idempotent',
  )
}
