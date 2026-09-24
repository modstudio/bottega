// concern: record-api-client
/** HTTP client for the record API. Must not know SQL or local table shape. */

import type { DocDelivery, DocRevisionOp } from '../doc/doc-write-allowed.ts'
import { MISSING_HOSTED_REVISION_REMEDY, RECORD_WRITE_REMEDY } from '../doc/doc-write-allowed.ts'
import type { VerdictInput } from '../verdict/verdict-payload.ts'
import { bearerHeaders, RECORD_SIGN_IN_REMEDY, type RecordIdentity } from './record-auth.ts'
import { storedRecordToken } from './record-session.ts'
import type { SnapshotKind } from './record-snapshots.ts'

const TEST_REFUSAL = 'record API client refuses a real base URL unless a stub is injected in tests'

export type RecordDocUpsertInput = {
  scope: string
  subject: string | null
  owner?: string | null
  slug: string
  title: string
  body: string
  delivery: DocDelivery
  projectName?: string | null
  reason: string
  author: string
  forceInject?: string
  op?: DocRevisionOp
  at?: string
  id?: string
  revisionId?: string
  expectedRevision?: string
}

export type RecordDocImportInput = {
  expectedRevision?: string
  doc: {
    scope: string
    subject: string | null
    owner?: string | null
    slug: string
    title: string
    body: string
    delivery: DocDelivery
    projectName?: string | null
    createdAt: string
    updatedAt: string
    deletedAt: string | null
  }
  revisions: Array<{
    scope: string
    subject: string | null
    owner?: string | null
    slug: string
    op: DocRevisionOp
    title: string
    body: string
    delivery: DocDelivery
    author: string
    reason: string
    sessionId?: string | null
    at: string
  }>
}

export type RecordApiClient = {
  whoami(): Promise<RecordIdentity>
  inviteMember(input: {
    email: string
    role: 'member' | 'admin' | 'owner'
    organizationId: string
  }): Promise<{ id: string }>
  putSnapshot(
    kind: SnapshotKind,
    input: { machineId: string; payload: unknown },
  ): Promise<{ takenAt: string }>
  listSnapshots(): Promise<{
    items: Array<{
      id: string
      kind: SnapshotKind
      machineId: string
      payload: unknown
      takenAt: string
    }>
  }>
  listDocs(query: {
    scope?: string
    subject?: string | null
    updatedSince?: string
    limit?: number
    cursor?: string | null
    includeDeleted?: boolean
    acrossReadableSpaces?: boolean
  }): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }>
  getDoc(id: string): Promise<Record<string, unknown>>
  listRevisions(id: string): Promise<Record<string, unknown>[]>
  upsertDoc(input: RecordDocUpsertInput): Promise<{ id: string; revisionId: string }>
  importDoc(input: RecordDocImportInput): Promise<{ id: string; revisionIds: string[] }>
  deleteDoc(
    id: string,
    input: { reason: string; author: string; expectedRevision?: string },
  ): Promise<{ id: string; revisionId: string }>
  consumeDoc(
    id: string,
    input: { reason: string; author: string; expectedRevision?: string },
  ): Promise<{ id: string; revisionId: string; alreadyConsumed: boolean }>
  restoreDoc(
    id: string,
    input: { revisionId: string; reason: string; author: string; expectedRevision?: string },
  ): Promise<{ id: string; revisionId: string }>
  renameSubject(input: {
    from: string
    to: string
    count: number
  }): Promise<{ docs: number; revisions: number }>
  upsertProject(input: {
    name: string
    previousName?: string
    path: string
    stack: string | null
    canon: boolean
    settings: Record<string, unknown>
    retiredAt: string | null
  }): Promise<{ name: string }>
  retireProject(name: string): Promise<{ name: string }>
  putScore(runId: string, input: VerdictInput): Promise<void>
  voidRun(runId: string, input: { reason: string }): Promise<void>
  unvoidRun(runId: string, input: { note: string }): Promise<void>
  listScores(query: {
    updatedSince?: string
    limit?: number
    cursor?: string | null
  }): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }>
  counts(): Promise<{ docs: number; revisions: number; scores: number; voids: number }>
}

const INJECT_KEY = Symbol.for('orch.record-api-client')
type InjectSlot = { current: RecordApiClient | null }

function injectSlot(): InjectSlot {
  const holder = globalThis as typeof globalThis & { [INJECT_KEY]?: InjectSlot }
  const existing = holder[INJECT_KEY]
  if (existing) return existing
  const created = { current: null }
  holder[INJECT_KEY] = created
  return created
}

function injectedClient(): RecordApiClient | null {
  return injectSlot().current
}

function recordApiUnreachable(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(`${detail}\n${RECORD_WRITE_REMEDY}`)
}

function recordApiError(body: unknown, status: number): Error {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const nested =
    record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : {}
  const message =
    (typeof record.error === 'string' && record.error) ||
    (typeof record.message === 'string' && record.message) ||
    (typeof nested.message === 'string' && nested.message) ||
    `record API ${status}`
  if (message.includes(MISSING_HOSTED_REVISION_REMEDY)) return new Error(message)
  return recordApiUnreachable(new Error(message))
}

function recordApiBaseUrl(): string {
  const url = process.env.ORCH_RECORD_API_URL
  if (!url) throw recordApiUnreachable(new Error('ORCH_RECORD_API_URL is not set'))
  if (process.env.NODE_ENV === 'test' && !injectedClient()) throw new Error(TEST_REFUSAL)
  return url.replace(/\/$/, '')
}

async function request<T>(
  path: string,
  init: RequestInit & { schema?: (body: unknown) => T } = {},
): Promise<T> {
  const token = storedRecordToken()
  if (!token) throw recordApiUnreachable(new Error(RECORD_SIGN_IN_REMEDY))
  const headers = new Headers(init.headers)
  for (const [name, value] of bearerHeaders(token)) headers.set(name, value)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  let response: Response
  try {
    response = await fetch(`${recordApiBaseUrl()}${path}`, { ...init, headers })
  } catch (error) {
    throw recordApiUnreachable(error)
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) throw recordApiError(body, response.status)
  return (init.schema ? init.schema(body) : (body as T)) as T
}

function ids(body: unknown): { id: string; revisionId: string } {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  if (typeof record.id !== 'string' || typeof record.revisionId !== 'string') {
    throw recordApiUnreachable(new Error('record API returned an invalid body'))
  }
  return { id: record.id, revisionId: record.revisionId }
}

function importIds(body: unknown): { id: string; revisionIds: string[] } {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  if (
    typeof record.id !== 'string' ||
    !Array.isArray(record.revisionIds) ||
    record.revisionIds.some((value) => typeof value !== 'string')
  ) {
    throw recordApiUnreachable(new Error('record API returned an invalid body'))
  }
  return { id: record.id, revisionIds: record.revisionIds as string[] }
}

export function recordApiClient(): RecordApiClient {
  const injected = injectedClient()
  if (injected) return injected
  if (process.env.NODE_ENV === 'test') throw new Error(TEST_REFUSAL)
  return {
    whoami: () => request('/v1/whoami'),
    inviteMember: (input) =>
      request('/api/auth/organization/invite-member', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    putSnapshot: (kind, input) =>
      request(`/v1/snapshots/${kind}`, { method: 'PUT', body: JSON.stringify(input) }),
    listSnapshots: () => request('/v1/snapshots'),
    listDocs: (query) => {
      const search = new URLSearchParams()
      if (query.scope) search.set('scope', query.scope)
      if (query.subject !== undefined) search.set('subject', query.subject ?? '')
      if (query.updatedSince) search.set('updatedSince', query.updatedSince)
      if (query.limit) search.set('limit', String(query.limit))
      if (query.cursor) search.set('cursor', query.cursor)
      if (query.includeDeleted) search.set('includeDeleted', 'true')
      if (query.acrossReadableSpaces) search.set('acrossReadableSpaces', 'true')
      const suffix = search.toString()
      return request(`/v1/docs${suffix ? `?${suffix}` : ''}`)
    },
    getDoc: (id) => request(`/v1/docs/${id}`),
    listRevisions: async (id) => {
      const body = await request<{ items?: Record<string, unknown>[] }>(`/v1/docs/${id}/revisions`)
      return Array.isArray(body) ? body : (body.items ?? [])
    },
    upsertDoc: (input) =>
      request('/v1/docs', { method: 'PUT', body: JSON.stringify(input) }).then(ids),
    importDoc: (input) =>
      request('/v1/docs/import', { method: 'POST', body: JSON.stringify(input) }).then(importIds),
    deleteDoc: (id, input) =>
      request(`/v1/docs/${id}`, { method: 'DELETE', body: JSON.stringify(input) }).then(ids),
    consumeDoc: async (id, input) => {
      const body = await request<Record<string, unknown>>(`/v1/docs/${id}/consume`, {
        method: 'POST',
        body: JSON.stringify(input),
      })
      return {
        ...ids(body),
        alreadyConsumed: Boolean(body.alreadyConsumed),
      }
    },
    restoreDoc: (id, input) =>
      request(`/v1/docs/${id}/restore`, { method: 'POST', body: JSON.stringify(input) }).then(ids),
    renameSubject: (input) =>
      request('/v1/docs/rename-subject', { method: 'POST', body: JSON.stringify(input) }),
    upsertProject: (input) =>
      request('/v1/projects', { method: 'PUT', body: JSON.stringify(input) }),
    retireProject: (name) =>
      request(`/v1/projects/${encodeURIComponent(name)}/retire`, { method: 'POST' }),
    putScore: async (runId, input) => {
      await request(`/v1/runs/${runId}/score`, { method: 'PUT', body: JSON.stringify(input) })
    },
    voidRun: async (runId, input) => {
      await request(`/v1/runs/${runId}/void`, { method: 'POST', body: JSON.stringify(input) })
    },
    unvoidRun: async (runId, input) => {
      await request(`/v1/runs/${runId}/unvoid`, { method: 'POST', body: JSON.stringify(input) })
    },
    listScores: (query) => {
      const search = new URLSearchParams()
      if (query.updatedSince) search.set('updatedSince', query.updatedSince)
      if (query.limit) search.set('limit', String(query.limit))
      if (query.cursor) search.set('cursor', query.cursor)
      const suffix = search.toString()
      return request(`/v1/scores${suffix ? `?${suffix}` : ''}`)
    },
    counts: () => request('/v1/docs/counts'),
  }
}
