// concern: record-api-client
/** HTTP client for the record API. Must not know SQL or local table shape. */

import type { DocDelivery, DocRevisionOp } from './doc-write-allowed.ts'
import { RECORD_WRITE_REMEDY } from './doc-write-allowed.ts'
import { bearerHeaders, RECORD_SIGN_IN_REMEDY } from './record-auth.ts'
import { storedRecordToken } from './record-session.ts'

const TEST_REFUSAL = 'record API client refuses a real base URL unless a stub is injected in tests'

export type RecordDocUpsertInput = {
  scope: string
  subject: string | null
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
}

export type RecordApiClient = {
  listDocs(query: {
    scope?: string
    subject?: string | null
    updatedSince?: string
    limit?: number
    cursor?: string | null
    includeDeleted?: boolean
  }): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }>
  getDoc(id: string): Promise<Record<string, unknown>>
  listRevisions(id: string): Promise<Record<string, unknown>[]>
  upsertDoc(input: RecordDocUpsertInput): Promise<{ id: string; revisionId: string }>
  deleteDoc(
    id: string,
    input: { reason: string; author: string },
  ): Promise<{ id: string; revisionId: string }>
  consumeDoc(
    id: string,
    input: { reason: string; author: string },
  ): Promise<{ id: string; revisionId: string; alreadyConsumed: boolean }>
  restoreDoc(
    id: string,
    input: { revisionId: string; reason: string; author: string },
  ): Promise<{ id: string; revisionId: string }>
  renameSubject(input: {
    from: string
    to: string
    count: number
  }): Promise<{ docs: number; revisions: number }>
  putScore(
    runId: string,
    input: {
      delivery: string
      quality: string | null
      fidelity: string | null
      note: string | null
      scoredAt: string
      scoredBy: string
    },
  ): Promise<void>
  voidRun(runId: string, input: { reason: string }): Promise<void>
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
  if (!response.ok) {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const error = typeof record.error === 'string' ? record.error : `record API ${response.status}`
    throw recordApiUnreachable(new Error(error))
  }
  return (init.schema ? init.schema(body) : (body as T)) as T
}

function ids(body: unknown): { id: string; revisionId: string } {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  if (typeof record.id !== 'string' || typeof record.revisionId !== 'string') {
    throw recordApiUnreachable(new Error('record API returned an invalid body'))
  }
  return { id: record.id, revisionId: record.revisionId }
}

export function recordApiClient(): RecordApiClient {
  const injected = injectedClient()
  if (injected) return injected
  if (process.env.NODE_ENV === 'test') throw new Error(TEST_REFUSAL)
  return {
    listDocs: (query) => {
      const search = new URLSearchParams()
      if (query.scope) search.set('scope', query.scope)
      if (query.subject !== undefined) search.set('subject', query.subject ?? '')
      if (query.updatedSince) search.set('updatedSince', query.updatedSince)
      if (query.limit) search.set('limit', String(query.limit))
      if (query.cursor) search.set('cursor', query.cursor)
      if (query.includeDeleted) search.set('includeDeleted', 'true')
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
    putScore: async (runId, input) => {
      await request(`/v1/runs/${runId}/score`, { method: 'PUT', body: JSON.stringify(input) })
    },
    voidRun: async (runId, input) => {
      await request(`/v1/runs/${runId}/void`, { method: 'POST', body: JSON.stringify(input) })
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
