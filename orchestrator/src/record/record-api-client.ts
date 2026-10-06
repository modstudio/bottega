// concern: record-api-client
/** HTTP client for the record API. Must not know SQL or local table shape. */

import type { DocAudience } from '../../../shared/docs.ts'
import type { CanonFinding } from '../canon/canon-lint.ts'
import type { DocDelivery, DocRevisionOp } from '../doc/doc-write-allowed.ts'
import { MISSING_HOSTED_REVISION_REMEDY, RECORD_WRITE_REMEDY } from '../doc/doc-write-allowed.ts'
import type { VerdictInput } from '../verdict/verdict-payload.ts'
import { bearerHeaders, RECORD_SIGN_IN_REMEDY, type RecordIdentity } from './record-auth.ts'
import type {
  HostedBoardAcceptInput,
  HostedBoardChanges,
  HostedBoardClaim,
  HostedBoardFilingCompleteInput,
  HostedBoardFilingFailInput,
  HostedBoardMessage,
  HostedBoardOverview,
  HostedBoardOverviewFilters,
  HostedBoardPostInput,
  HostedBoardReceipt,
  HostedBoardReceiptInput,
  HostedBoardReplyInput,
  HostedBoardSessionInput,
  HostedBoardStatus,
  HostedBoardTakeClaimInput,
  HostedBoardThread,
} from './record-board-contract.ts'
import type {
  PublicRecordDoc,
  PublicRecordDocTreeItem,
  RecordDocSearchMatch,
} from './record-public-docs.ts'
import { storedRecordToken } from './record-session.ts'
import type {
  RecordSettingsPermissionInput,
  RecordSettingsPermissionResult,
} from './record-settings.ts'
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
  audience: DocAudience
  parentRecordId?: string | null
  position: number
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
    id?: string
    scope: string
    subject: string | null
    owner?: string | null
    slug: string
    title: string
    body: string
    delivery: DocDelivery
    audience?: DocAudience
    parentId?: string | null
    position?: number
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
    audience?: DocAudience
    parentId?: string | null
    position?: number
    author: string
    reason: string
    sessionId?: string | null
    at: string
  }>
}

export type RecordCanonImportInput = {
  address: { kind: 'user' } | { kind: 'project'; subject: string }
  rows: Array<{ slug: string; title: string; body: string }>
  expectedRevisions: Record<string, string>
  reason: string
  author: string
}

export type RecordCanonImportResult = {
  rows: Array<{ slug: string; id: string; revisionId: string }>
  deletions: Array<{ slug: string; id: string; revisionId: string }>
  findings: CanonFinding[]
  bootstrap: boolean
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
  listPublicDocs(): Promise<{ items: PublicRecordDocTreeItem[] }>
  getPublicDoc(id: string): Promise<PublicRecordDoc>
  searchPublicDocs(query: string): Promise<{ items: RecordDocSearchMatch[] }>
  searchDocs(query: {
    q: string
    scope?: string
    subject?: string | null
    audience?: DocAudience
    acrossReadableSpaces?: boolean
  }): Promise<{ items: RecordDocSearchMatch[] }>
  listDocs(query: {
    scope?: string
    subject?: string | null
    audience?: DocAudience
    updatedSince?: string
    limit?: number
    cursor?: string | null
    includeDeleted?: boolean
    acrossReadableSpaces?: boolean
  }): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }>
  getDoc(id: string): Promise<Record<string, unknown>>
  listRevisions(id: string): Promise<Record<string, unknown>[]>
  upsertDoc(input: RecordDocUpsertInput): Promise<{ id: string; revisionId: string }>
  applySettingsPermission(
    input: Omit<RecordSettingsPermissionInput, 'url' | 'userId' | 'spaceId' | 'spaceIds'>,
  ): Promise<RecordSettingsPermissionResult>
  importDoc(input: RecordDocImportInput): Promise<{ id: string; revisionIds: string[] }>
  importCanon(input: RecordCanonImportInput): Promise<RecordCanonImportResult>
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
  listBoardMessages(query?: HostedBoardOverviewFilters): Promise<HostedBoardOverview>
  postBoardMessage(input: HostedBoardPostInput): Promise<HostedBoardMessage>
  replyBoardMessage(rootId: string, input: HostedBoardReplyInput): Promise<HostedBoardMessage>
  withdrawBoardMessage(id: string, input?: HostedBoardSessionInput): Promise<HostedBoardMessage>
  acceptBoardAnswer(id: string, input: HostedBoardAcceptInput): Promise<HostedBoardThread>
  takeBoardFilingLease(id: string, input?: HostedBoardSessionInput): Promise<HostedBoardMessage>
  completeBoardFilingLease(
    id: string,
    input: HostedBoardFilingCompleteInput,
  ): Promise<HostedBoardMessage>
  failBoardFilingLease(id: string, input: HostedBoardFilingFailInput): Promise<HostedBoardMessage>
  getBoardThread(id: string): Promise<HostedBoardThread>
  getBoardStatus(id: string): Promise<HostedBoardStatus>
  putBoardReceipt(input: HostedBoardReceiptInput): Promise<HostedBoardReceipt>
  listBoardChanges(query: { after?: string; limit?: number }): Promise<HostedBoardChanges>
  takeBoardClaim(
    input: HostedBoardTakeClaimInput,
  ): Promise<HostedBoardClaim & { action: 'taken' | 'renewed' | 'taken-over' }>
  renewBoardClaim(id: string, input?: { holderSession?: string | null }): Promise<HostedBoardClaim>
  releaseBoardClaim(
    id: string,
    input?: { holderSession?: string | null },
  ): Promise<HostedBoardClaim>
  listBoardClaims(project: string): Promise<{ claims: HostedBoardClaim[] }>
  releaseBoardTaskClaims(input: { project: string; key: string }): Promise<{ released: number }>
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

export class RecordApiRequestError extends Error {
  readonly kind: 'unreachable' | 'refused'

  constructor(message: string, kind: 'unreachable' | 'refused') {
    super(message)
    this.kind = kind
  }
}

function recordApiUnreachable(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new RecordApiRequestError(`${detail}\n${RECORD_WRITE_REMEDY}`, 'unreachable')
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
  if (message.includes(MISSING_HOSTED_REVISION_REMEDY))
    return new RecordApiRequestError(message, 'refused')
  if (status >= 400 && status < 500)
    return new RecordApiRequestError(`${message}\n${RECORD_WRITE_REMEDY}`, 'refused')
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

async function publicRequest<T>(path: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${recordApiBaseUrl()}${path}`, {
      method: 'GET',
      credentials: 'omit',
      headers: new Headers(),
    })
  } catch (error) {
    throw recordApiUnreachable(error)
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) throw recordApiError(body, response.status)
  return body as T
}

function docSearchParams(query: {
  q: string
  scope?: string
  subject?: string | null
  audience?: DocAudience
  acrossReadableSpaces?: boolean
}): string {
  const search = new URLSearchParams({ q: query.q })
  if (query.scope) search.set('scope', query.scope)
  if (query.subject !== undefined) search.set('subject', query.subject ?? '')
  if (query.audience) search.set('audience', query.audience)
  if (query.acrossReadableSpaces) search.set('acrossReadableSpaces', 'true')
  return search.toString()
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
    listPublicDocs: () => publicRequest('/public/v1/docs'),
    getPublicDoc: (id) => publicRequest(`/public/v1/docs/${id}`),
    searchPublicDocs: (query) =>
      publicRequest(`/public/v1/docs/search?${new URLSearchParams({ q: query })}`),
    searchDocs: (query) => request(`/v1/docs/search?${docSearchParams(query)}`),
    listDocs: (query) => {
      const search = new URLSearchParams()
      if (query.scope) search.set('scope', query.scope)
      if (query.subject !== undefined) search.set('subject', query.subject ?? '')
      if (query.audience) search.set('audience', query.audience)
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
    applySettingsPermission: (input) =>
      request('/v1/settings/permission', { method: 'POST', body: JSON.stringify(input) }),
    importDoc: (input) =>
      request('/v1/docs/import', { method: 'POST', body: JSON.stringify(input) }).then(importIds),
    importCanon: (input) =>
      request('/v1/docs/canon/import', { method: 'POST', body: JSON.stringify(input) }),
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
    listBoardMessages: (query = {}) => {
      const search = new URLSearchParams()
      if (query.kind) search.set('kind', query.kind)
      if (query.open !== undefined) search.set('open', String(query.open))
      if (query.includeEnded !== undefined) search.set('includeEnded', String(query.includeEnded))
      const suffix = search.toString()
      return request(`/v1/board/messages${suffix ? `?${suffix}` : ''}`)
    },
    postBoardMessage: (input) =>
      request('/v1/board/messages', { method: 'PUT', body: JSON.stringify(input) }),
    replyBoardMessage: (rootId, input) =>
      request(`/v1/board/messages/${rootId}/replies`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    withdrawBoardMessage: (id, input) =>
      request(`/v1/board/messages/${id}/withdraw`, {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      }),
    acceptBoardAnswer: (id, input) =>
      request(`/v1/board/messages/${id}/accept`, { method: 'POST', body: JSON.stringify(input) }),
    takeBoardFilingLease: (id, input) =>
      request(`/v1/board/messages/${id}/filing-lease`, {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      }),
    completeBoardFilingLease: (id, input) =>
      request(`/v1/board/messages/${id}/filing-lease/complete`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    failBoardFilingLease: (id, input) =>
      request(`/v1/board/messages/${id}/filing-lease/fail`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    getBoardThread: (id) => request(`/v1/board/threads/${id}`),
    getBoardStatus: (id) => request(`/v1/board/messages/${id}/status`),
    putBoardReceipt: (input) =>
      request('/v1/board/receipts', { method: 'PUT', body: JSON.stringify(input) }),
    listBoardChanges: (query) => {
      const search = new URLSearchParams()
      if (query.after) search.set('after', query.after)
      if (query.limit) search.set('limit', String(query.limit))
      const suffix = search.toString()
      return request(`/v1/board/changes${suffix ? `?${suffix}` : ''}`)
    },
    takeBoardClaim: (input) =>
      request('/v1/board/claims', { method: 'PUT', body: JSON.stringify(input) }),
    renewBoardClaim: (id, input) =>
      request(`/v1/board/claims/${id}/renew`, {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      }),
    releaseBoardClaim: (id, input) =>
      request(`/v1/board/claims/${id}/release`, {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      }),
    listBoardClaims: (project) =>
      request(`/v1/board/claims?project=${encodeURIComponent(project)}`),
    releaseBoardTaskClaims: (input) =>
      request('/v1/board/claims/release-task', { method: 'POST', body: JSON.stringify(input) }),
  }
}
