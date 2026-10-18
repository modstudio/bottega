// concern: record-api-client
/** HTTP client for the record API. Must not know SQL or local table shape. */

import type {
  DocAudience,
  DocAudiences,
  DocForm,
  DocKind,
  DocStatus,
} from '../../../shared/docs.ts'
import { resolveRecordApiUrl } from '../../../shared/record-api-url.ts'
import { RECORD_ACTIVE_SPACE_REMEDY } from '../../../shared/record-remedies.ts'
import type { CanonFinding } from '../canon/canon-lint.ts'
import type { DocGenerator } from '../doc/doc-generator.ts'
import type { DocDelivery, DocRevisionOp } from '../doc/doc-write-allowed.ts'
import { MISSING_HOSTED_REVISION_REMEDY, RECORD_WRITE_REMEDY } from '../doc/doc-write-allowed.ts'
import type { VerdictInput } from '../verdict/verdict-payload.ts'
import { type RecordCatalogueClient, recordLensClient } from './record-api-client-lens.ts'
import {
  boardClaimListPath,
  docSearchParams,
  type ProjectIdentityClient,
  projectIdentityClient,
  type RecordApiAuthentication,
  type RecordBoardMethod,
  type RecordBoardStreamOpen,
  type RecordBoardStreamSource,
  type RecordBoardWatchMethod,
  type RecordDocOrderInput,
  type RecordDocReadMethod,
  type RecordDocWriteMethod,
  type RecordIdentityAndSpaceMethod,
  type RecordProjectSubjectMethod,
  type RecordRequestDestination,
  type RecordRunMethod,
  type RecordSnapshotAndPublicDocMethod,
  subjectMutationBody,
} from './record-api-client-paths.ts'
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
import {
  type RecordDocWriteResponse,
  recordDocWriteResponseFields,
} from './record-doc-transport-contract.ts'
import type { HostedRecordInvitation } from './record-pending-invitations.ts'
import type {
  PublicRecordDoc,
  PublicRecordDocTreeItem,
  RecordDocSearchMatch,
} from './record-public-docs.ts'
import { storedRecordToken, storedRecordTokenAsync } from './record-session.ts'
import type {
  RecordSettingsPermissionInput,
  RecordSettingsPermissionResult,
} from './record-settings.ts'
import type { SnapshotKind } from './record-snapshots.ts'
import type { RecordSubject } from './record-subjects.ts'
import type { RecordSyncRequest, RecordSyncResponse } from './record-sync-contract.ts'

const TEST_REFUSAL = 'record API client refuses a real base URL unless a stub is injected in tests'

export type RecordDocUpsertInput = {
  scope: string
  subject: string | null
  owner?: string | null
  slug: string
  title: string
  body: string
  delivery: DocDelivery
  audiences: DocAudiences
  parentRecordId?: string | null
  position: number
  featured?: boolean
  status?: DocStatus
  kind?: DocKind
  form?: DocForm | null
  articleSubjectId?: string | null
  relatedSubjectIds?: string[]
  sourceFiles?: string[]
  checkedAgainstCommit?: string | null
  summary?: string | null
  replacementSlug?: string | null
  projectName?: string | null
  projectId?: string | null
  reason: string
  author: string
  forceInject?: string
  op?: DocRevisionOp
  at?: string
  id?: string
  revisionId?: string
  expectedRevision?: string
  generator?: DocGenerator
}
type RecordDocImportResult = RecordDocWriteResponse<{ id: string; revisionIds: string[] }>

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
    audiences?: DocAudiences
    parentId?: string | null
    position?: number
    featured?: boolean
    status?: DocStatus
    kind?: DocKind
    form?: DocForm | null
    articleSubjectId?: string | null
    relatedSubjectIds?: string[]
    sourceFiles?: string[]
    checkedAgainstCommit?: string | null
    summary?: string | null
    replacementSlug?: string | null
    projectName?: string | null
    projectId?: string | null
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
    audiences?: DocAudiences
    parentId?: string | null
    position?: number
    featured?: boolean
    status?: DocStatus
    kind?: DocKind
    form?: DocForm | null
    articleSubjectId?: string | null
    relatedSubjectIds?: string[]
    sourceFiles?: string[]
    checkedAgainstCommit?: string | null
    summary?: string | null
    replacementSlug?: string | null
    author: string
    reason: string
    sessionId?: string | null
    at: string
  }>
}

export type RecordCanonImportInput = {
  address: { kind: 'user' } | { kind: 'project'; subject: string; projectId: string }
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

export type {
  RecordApiAuthentication,
  RecordBoardStreamOpen,
  RecordRequestDestination,
} from './record-api-client-paths.ts'

export type RecordApiClient = ProjectIdentityClient &
  RecordCatalogueClient & {
    whoami(): Promise<RecordIdentity>
    sync?(input: RecordSyncRequest): Promise<RecordSyncResponse>
    createOrganization(input: { name: string; slug: string }): Promise<{ id: string; slug: string }>
    setActiveOrganization(input: {
      organizationId?: string
      organizationSlug?: string
    }): Promise<{ id: string; slug: string }>
    listInvitations(): Promise<HostedRecordInvitation[]>
    acceptInvitation(invitationId: string): Promise<{ invitation: { organizationId: string } }>
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
    listDocs(
      query: {
        scope?: string
        subject?: string | null
        audience?: DocAudience
        status?: DocStatus
        updatedSince?: string
        limit?: number
        cursor?: string | null
        includeDeleted?: boolean
        kind?: DocKind
        acrossReadableSpaces?: boolean
      },
      destination?: RecordRequestDestination,
    ): Promise<{
      items: Record<string, unknown>[]
      nextCursor: string | null
      endCursor?: string | null
    }>
    getDoc(id: string, destination?: RecordRequestDestination): Promise<Record<string, unknown>>
    listRevisions(
      id: string,
      destination?: RecordRequestDestination,
    ): Promise<Record<string, unknown>[]>
    upsertDoc(
      input: RecordDocUpsertInput,
      destination?: RecordRequestDestination,
    ): Promise<RecordDocWriteResponse<{ id: string; revisionId: string }>>
    reorderDocs(
      input: RecordDocOrderInput,
      destination?: RecordRequestDestination,
    ): Promise<{ orderedIds: string[] }>
    applySettingsPermission(
      input: Omit<RecordSettingsPermissionInput, 'url' | 'userId' | 'spaceId' | 'spaceIds'>,
      destination?: RecordRequestDestination,
    ): Promise<RecordSettingsPermissionResult>
    importDoc(
      input: RecordDocImportInput,
      destination?: RecordRequestDestination,
    ): Promise<RecordDocImportResult>
    importCanon(
      input: RecordCanonImportInput,
      destination?: RecordRequestDestination,
    ): Promise<RecordCanonImportResult>
    deleteDoc(
      id: string,
      input: {
        reason: string
        author: string
        expectedRevision?: string
        generator?: DocGenerator
      },
      destination?: RecordRequestDestination,
    ): Promise<{ id: string; revisionId: string }>
    consumeDoc(
      id: string,
      input: { reason: string; author: string; expectedRevision?: string },
      destination?: RecordRequestDestination,
    ): Promise<{ id: string; revisionId: string; alreadyConsumed: boolean }>
    restoreDoc(
      id: string,
      input: { revisionId: string; reason: string; author: string; expectedRevision?: string },
      destination?: RecordRequestDestination,
    ): Promise<{ id: string; revisionId: string }>
    renameSubject(
      input: {
        from: string
        to: string
        count: number
      },
      destination?: RecordRequestDestination,
    ): Promise<{ docs: number; revisions: number }>
    listProjectSubjects(
      query: {
        project?: string
        projectId?: string | null
        includeRetired?: boolean
        order?: 'catalog' | 'updated'
        cursor?: string
        limit?: number
      },
      destination?: RecordRequestDestination,
    ): Promise<{ items: RecordSubject[]; nextCursor: string | null; endCursor?: string | null }>
    addProjectSubject(
      input: {
        id: string
        project: string
        projectId?: string | null
        name: string
        definition: string
      },
      destination?: RecordRequestDestination,
    ): Promise<RecordSubject>
    renameProjectSubject(
      input: { project: string; projectId?: string | null; id: string; name: string },
      destination?: RecordRequestDestination,
    ): Promise<RecordSubject>
    defineProjectSubject(
      input: { project: string; projectId?: string | null; id: string; definition: string },
      destination?: RecordRequestDestination,
    ): Promise<RecordSubject>
    reorderProjectSubjects(
      input: { project: string; projectId?: string | null; ids: string[] },
      destination?: RecordRequestDestination,
    ): Promise<{ items: RecordSubject[] }>
    retireProjectSubject(
      input: { project: string; projectId?: string | null; id: string },
      destination?: RecordRequestDestination,
    ): Promise<RecordSubject>
    putScore(runId: string, input: VerdictInput): Promise<void>
    voidRun(runId: string, input: { reason: string }): Promise<void>
    unvoidRun(runId: string, input: { note: string }): Promise<void>
    listScores(query: {
      updatedSince?: string
      limit?: number
      cursor?: string | null
    }): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }>
    counts(
      destination?: RecordRequestDestination,
    ): Promise<{ docs: number; revisions: number; scores: number; voids: number }>
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
    putBoardReceipt(
      input: HostedBoardReceiptInput,
      signal?: AbortSignal,
    ): Promise<HostedBoardReceipt>
    listBoardChanges(query: {
      after?: string
      limit?: number
      signal?: AbortSignal
    }): Promise<HostedBoardChanges>
    takeBoardClaim(
      input: HostedBoardTakeClaimInput,
    ): Promise<HostedBoardClaim & { action: 'taken' | 'renewed' | 'taken-over' }>
    renewBoardClaim(
      id: string,
      input?: { holderSession?: string | null },
    ): Promise<HostedBoardClaim>
    releaseBoardClaim(
      id: string,
      input?: { holderSession?: string | null },
    ): Promise<HostedBoardClaim>
    listBoardClaims(
      project: string,
      projectId?: string | null,
    ): Promise<{ claims: HostedBoardClaim[] }>
    releaseBoardTaskClaims(input: {
      project: string
      projectId?: string | null
      key: string
    }): Promise<{ released: number }>
    openBoardStream(signal?: AbortSignal): Promise<RecordBoardStreamOpen>
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
  readonly status: number | null

  constructor(message: string, kind: 'unreachable' | 'refused', status: number | null = null) {
    super(message)
    this.kind = kind
    this.status = status
  }
}

function recordApiUnreachable(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new RecordApiRequestError(
    `record API is unreachable: ${detail}\n${RECORD_WRITE_REMEDY}`,
    'unreachable',
  )
}

function responseRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
}

function responseMessage(body: unknown, fallback: string): string {
  const record = responseRecord(body)
  const nested = responseRecord(record.error)
  return (
    (typeof record.error === 'string' && record.error) ||
    (typeof record.message === 'string' && record.message) ||
    (typeof nested.message === 'string' && nested.message) ||
    fallback
  )
}

function recordApiError(body: unknown, status: number, headers: Headers = new Headers()): Error {
  if (status === 401) return recordAuthRefusal(status, body, headers)
  const message = responseMessage(body, `record API ${status}`)
  if (status === 429) return new RecordApiRequestError(message, 'refused', status)
  if (message === RECORD_ACTIVE_SPACE_REMEDY)
    return new RecordApiRequestError(message, 'refused', status)
  if (message.includes(MISSING_HOSTED_REVISION_REMEDY))
    return new RecordApiRequestError(message, 'refused', status)
  if (status >= 400 && status < 500) return new RecordApiRequestError(message, 'refused', status)
  return recordApiUnreachable(new Error(message))
}

export function recordAuthToken(headers: Headers, body: unknown): string | null {
  const fromHeader = headers.get('set-auth-token')?.trim()
  if (fromHeader) return fromHeader
  const token = responseRecord(body).token
  return typeof token === 'string' && token.trim() ? token : null
}

export function recordAuthRefusal(status: number, body: unknown, headers: Headers): Error {
  if (status === 401)
    return new RecordApiRequestError(
      `record credentials were refused; ${RECORD_SIGN_IN_REMEDY}`,
      'refused',
    )
  if (status === 429) {
    const interval = headers.get('retry-after') ?? headers.get('x-ratelimit-reset') ?? 'later'
    return new RecordApiRequestError(
      `record sign-in is rate limited; retry after ${interval}`,
      'refused',
    )
  }
  const message = responseMessage(body, `record API ${status}`)
  if (status >= 400 && status < 500) return new RecordApiRequestError(message, 'refused')
  return recordApiUnreachable(new Error(message))
}

async function recordEmailAuthRequest(
  path: '/api/auth/sign-in/email' | '/api/auth/sign-up/email',
  body: Record<string, string>,
) {
  let response: Response
  try {
    response = await fetch(`${recordApiBaseUrl()}${path}`, {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new RecordApiRequestError(
      `record API is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      'unreachable',
    )
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw recordAuthRefusal(response.status, payload, response.headers)
  const token = recordAuthToken(response.headers, payload)
  const user = responseRecord(payload).user
  if (!token || !user || typeof user !== 'object') throw new Error(RECORD_SIGN_IN_REMEDY)
  return { token, user: user as Record<string, unknown> }
}

export const recordApiSignIn = (email: string, password: string) =>
  recordEmailAuthRequest('/api/auth/sign-in/email', { email, password })

export const recordApiSignUp = (email: string, name: string, password: string) =>
  recordEmailAuthRequest('/api/auth/sign-up/email', { email, name, password })

export function recordIdentityResponse(body: unknown): RecordIdentity {
  const value = responseRecord(body)
  const user = responseRecord(value.user)
  const memberships = Array.isArray(value.memberships)
    ? value.memberships.map((membership) => responseRecord(membership))
    : null
  if (
    typeof user.id !== 'string' ||
    (value.activeSpaceId !== null && typeof value.activeSpaceId !== 'string') ||
    (value.personalSpaceId !== null && typeof value.personalSpaceId !== 'string') ||
    !memberships ||
    memberships.some((membership) =>
      ['space_id', 'name', 'slug', 'role', 'permission'].some(
        (field) => typeof membership[field] !== 'string',
      ),
    )
  ) {
    throw recordApiUnreachable(new Error('record API returned an invalid identity'))
  }
  return {
    user: user as RecordIdentity['user'],
    activeSpaceId: value.activeSpaceId,
    personalSpaceId: value.personalSpaceId,
    memberships,
  }
}

export function recordApiBaseUrl(
  environment: Record<string, string | undefined> = process.env,
): string {
  const url = resolveRecordApiUrl(environment)
  if (!url) throw recordApiUnreachable(new Error('ORCH_RECORD_API_URL is not set'))
  if (
    environment.NODE_ENV === 'test' &&
    !environment.ORCH_TEST_POSTGRES_CONTAINER &&
    !injectedClient()
  )
    throw new Error(TEST_REFUSAL)
  return url.replace(/\/$/, '')
}

async function recordApiRequest<T>(
  path: string,
  init: RequestInit & { schema?: (body: unknown) => T; destinationSpaceId?: string } = {},
  authentication?: RecordApiAuthentication,
): Promise<T> {
  const baseUrl = recordApiBaseUrl()
  const token = init.signal
    ? await (authentication
        ? authentication.tokenAsync(init.signal)
        : storedRecordTokenAsync(undefined, init.signal))
    : authentication
      ? authentication.token()
      : storedRecordToken()
  if (!token) throw new RecordApiRequestError(RECORD_SIGN_IN_REMEDY, 'refused')
  const headers = new Headers(init.headers)
  for (const [name, value] of bearerHeaders(token)) headers.set(name, value)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  if (init.destinationSpaceId) headers.set('x-record-space', init.destinationSpaceId)
  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}`, { ...init, headers })
  } catch (error) {
    throw recordApiUnreachable(error)
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) throw recordApiError(body, response.status, response.headers)
  return (init.schema ? init.schema(body) : (body as T)) as T
}

const defaultRequest = recordApiRequest

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

function ids(body: unknown): RecordDocWriteResponse<{ id: string; revisionId: string }> {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  if (typeof record.id !== 'string' || typeof record.revisionId !== 'string') {
    throw recordApiUnreachable(new Error('record API returned an invalid body'))
  }
  return {
    id: record.id,
    revisionId: record.revisionId,
    ...recordDocWriteResponseFields(record),
  }
}

function importIds(body: unknown): RecordDocImportResult {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  if (
    typeof record.id !== 'string' ||
    !Array.isArray(record.revisionIds) ||
    record.revisionIds.some((value) => typeof value !== 'string')
  ) {
    throw recordApiUnreachable(new Error('record API returned an invalid body'))
  }
  return {
    id: record.id,
    revisionIds: record.revisionIds as string[],
    ...recordDocWriteResponseFields(record),
  }
}

function organizationResponse(body: unknown): { id: string; slug: string } {
  const value = responseRecord(body)
  if (typeof value.id !== 'string' || typeof value.slug !== 'string')
    throw recordApiUnreachable(new Error('record API returned an invalid organization'))
  return { id: value.id, slug: value.slug }
}

export function recordInvitationListResponse(body: unknown): HostedRecordInvitation[] {
  if (!Array.isArray(body))
    throw recordApiUnreachable(new Error('record API returned an invalid invitation list'))
  return body.map((row) => {
    const value = responseRecord(row)
    for (const field of [
      'id',
      'spaceName',
      'spaceSlug',
      'role',
      'inviterEmail',
      'expiresAt',
    ] as const) {
      if (typeof value[field] !== 'string')
        throw recordApiUnreachable(new Error('record API returned an invalid invitation list'))
    }
    const expiresAt = new Date(value.expiresAt as string)
    if (Number.isNaN(expiresAt.getTime()))
      throw recordApiUnreachable(new Error('record API returned an invalid invitation'))
    return value as HostedRecordInvitation
  })
}

function acceptedInvitationResponse(
  body: unknown,
): Awaited<ReturnType<RecordApiClient['acceptInvitation']>> {
  const value = responseRecord(body)
  const invitation = responseRecord(value.invitation)
  if (typeof invitation.organizationId !== 'string')
    throw recordApiUnreachable(new Error('record API returned an invalid accepted invitation'))
  return { invitation: { organizationId: invitation.organizationId } }
}

async function listDocRevisionsRequest(
  id: string,
  destination?: RecordRequestDestination,
): Promise<Record<string, unknown>[]> {
  const body = await defaultRequest<{ items?: Record<string, unknown>[] }>(
    `/v1/docs/${id}/revisions`,
    destination,
  )
  return Array.isArray(body) ? body : (body.items ?? [])
}

const reorderDocsRequest: RecordApiClient['reorderDocs'] = (input, destination) =>
  defaultRequest('/v1/docs/order', {
    method: 'PUT',
    body: JSON.stringify(input),
    ...destination,
  })

export function authenticatedRecordApiClient(
  authentication: RecordApiAuthentication,
): RecordApiClient {
  return recordApiClient((path, init) => recordApiRequest(path, init, authentication))
}

export function recordApiClient(request = defaultRequest): RecordApiClient {
  const injected = injectedClient()
  if (injected) return injected
  if (process.env.NODE_ENV === 'test' && !process.env.ORCH_TEST_POSTGRES_CONTAINER)
    throw new Error(TEST_REFUSAL)
  return {
    ...recordIdentityAndSpaceClient(request),
    ...recordSnapshotAndPublicDocClient(request),
    ...recordDocReadClient(request),
    ...recordDocWriteClient(request),
    ...recordLensClient(request),
    ...projectIdentityClient(request),
    ...recordProjectSubjectClient(request),
    ...recordRunClient(request),
    ...recordBoardClient(request),
    ...recordApiBoardWatchClient(),
  }
}

const recordSnapshotAndPublicDocClient = (
  request = defaultRequest,
): Pick<RecordApiClient, RecordSnapshotAndPublicDocMethod> => ({
  putSnapshot: (kind, input) =>
    request(`/v1/snapshots/${kind}`, { method: 'PUT', body: JSON.stringify(input) }),
  listSnapshots: () => request('/v1/snapshots'),
  listPublicDocs: () => publicRequest('/public/v1/docs'),
  getPublicDoc: (id) => publicRequest(`/public/v1/docs/${id}`),
  searchPublicDocs: (query) =>
    publicRequest(`/public/v1/docs/search?${new URLSearchParams({ q: query })}`),
})

const recordDocReadClient = (
  request = defaultRequest,
): Pick<RecordApiClient, RecordDocReadMethod> => ({
  searchDocs: (query) => request(`/v1/docs/search?${docSearchParams(query)}`),
  listDocs: (query, destination) => {
    const search = new URLSearchParams()
    if (query.scope) search.set('scope', query.scope)
    if (query.subject !== undefined) search.set('subject', query.subject ?? '')
    if (query.audience) search.set('audience', query.audience)
    if (query.status) search.set('status', query.status)
    if (query.kind) search.set('kind', query.kind)
    if (query.updatedSince) search.set('updatedSince', query.updatedSince)
    if (query.limit) search.set('limit', String(query.limit))
    if (query.cursor) search.set('cursor', query.cursor)
    if (query.includeDeleted) search.set('includeDeleted', 'true')
    if (query.acrossReadableSpaces) search.set('acrossReadableSpaces', 'true')
    const suffix = search.toString()
    return request(`/v1/docs${suffix ? `?${suffix}` : ''}`, destination)
  },
  getDoc: (id, destination) => request(`/v1/docs/${id}`, destination),
  listRevisions: listDocRevisionsRequest,
})

const recordDocWriteClient = (
  request = defaultRequest,
): Pick<RecordApiClient, RecordDocWriteMethod> => ({
  upsertDoc: (input, destination) =>
    request('/v1/docs', { method: 'PUT', body: JSON.stringify(input), ...destination }).then(ids),
  reorderDocs: reorderDocsRequest,
  applySettingsPermission: (input, destination) =>
    request('/v1/settings/permission', {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
    }),
  importDoc: (input, destination) =>
    request('/v1/docs/import', {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
    }).then(importIds),
  importCanon: (input, destination) =>
    request('/v1/docs/canon/import', {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
    }),
  deleteDoc: (id, input, destination) =>
    request(`/v1/docs/${id}`, {
      method: 'DELETE',
      body: JSON.stringify(input),
      ...destination,
    }).then(ids),
  consumeDoc: async (id, input, destination) => {
    const body = await request<Record<string, unknown>>(`/v1/docs/${id}/consume`, {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
    })
    return {
      ...ids(body),
      alreadyConsumed: Boolean(body.alreadyConsumed),
    }
  },
  restoreDoc: (id, input, destination) =>
    request(`/v1/docs/${id}/restore`, {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
    }).then(ids),
  renameSubject: (input, destination) =>
    request('/v1/docs/rename-subject', {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
    }),
})

const recordProjectSubjectClient = (
  request = defaultRequest,
): Pick<RecordApiClient, RecordProjectSubjectMethod> => ({
  listProjectSubjects: (query, destination) => {
    const search = new URLSearchParams()
    if (query.project) search.set('project', query.project)
    if (query.projectId) search.set('projectId', query.projectId)
    if (query.includeRetired) search.set('includeRetired', 'true')
    if (query.order) search.set('order', query.order)
    if (query.cursor) search.set('cursor', query.cursor)
    if (query.limit) search.set('limit', String(query.limit))
    return request(`/v1/subjects?${search}`, destination)
  },
  addProjectSubject: (input, destination) =>
    request('/v1/subjects', { method: 'PUT', body: JSON.stringify(input), ...destination }),
  renameProjectSubject: (input, destination) =>
    request(`/v1/subjects/${input.id}/rename`, {
      method: 'POST',
      body: subjectMutationBody(input, { name: input.name }),
      ...destination,
    }),
  defineProjectSubject: (input, destination) =>
    request(`/v1/subjects/${input.id}/define`, {
      method: 'POST',
      body: subjectMutationBody(input, { definition: input.definition }),
      ...destination,
    }),
  reorderProjectSubjects: (input, destination) =>
    request('/v1/subjects/reorder', {
      method: 'POST',
      body: JSON.stringify(input),
      ...destination,
    }),
  retireProjectSubject: (input, destination) =>
    request(`/v1/subjects/${input.id}/retire`, {
      method: 'POST',
      body: JSON.stringify({ project: input.project, projectId: input.projectId }),
      ...destination,
    }),
})

const recordRunClient = (request = defaultRequest): Pick<RecordApiClient, RecordRunMethod> => ({
  putScore: async (runId, input) =>
    void (await request(`/v1/runs/${runId}/score`, { method: 'PUT', body: JSON.stringify(input) })),
  voidRun: async (runId, input) =>
    void (await request(`/v1/runs/${runId}/void`, { method: 'POST', body: JSON.stringify(input) })),
  unvoidRun: async (runId, input) =>
    void (await request(`/v1/runs/${runId}/unvoid`, {
      method: 'POST',
      body: JSON.stringify(input),
    })),
  listScores: (query) => {
    const search = new URLSearchParams()
    if (query.updatedSince) search.set('updatedSince', query.updatedSince)
    if (query.limit) search.set('limit', String(query.limit))
    if (query.cursor) search.set('cursor', query.cursor)
    const suffix = search.toString()
    return request(`/v1/scores${suffix ? `?${suffix}` : ''}`)
  },
  counts: (destination) => request('/v1/docs/counts', destination),
})

const recordBoardClient = (request = defaultRequest): Pick<RecordApiClient, RecordBoardMethod> => ({
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
  putBoardReceipt: (input, signal) =>
    request('/v1/board/receipts', { method: 'PUT', body: JSON.stringify(input), signal }),
  listBoardChanges: listBoardChangesRequest,
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
  listBoardClaims: (project, projectId) => request(boardClaimListPath(project, projectId)),
})

function recordIdentityAndSpaceClient(
  request = defaultRequest,
): Pick<RecordApiClient, RecordIdentityAndSpaceMethod> {
  return {
    whoami: () => request('/v1/whoami', { schema: recordIdentityResponse }),
    sync: (input) => request('/v1/sync', { method: 'POST', body: JSON.stringify(input) }),
    createOrganization: (input) =>
      request('/api/auth/organization/create', {
        method: 'POST',
        body: JSON.stringify(input),
        schema: organizationResponse,
      }),
    setActiveOrganization: (input) =>
      request('/api/auth/organization/set-active', {
        method: 'POST',
        body: JSON.stringify(input),
        schema: organizationResponse,
      }),
    listInvitations: () =>
      request('/v1/invitations', {
        schema: recordInvitationListResponse,
      }),
    acceptInvitation: (invitationId) =>
      request('/api/auth/organization/accept-invitation', {
        method: 'POST',
        body: JSON.stringify({ invitationId }),
        schema: acceptedInvitationResponse,
      }),
    inviteMember: (input) =>
      request('/api/auth/organization/invite-member', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  }
}

function listBoardChangesRequest(query: {
  after?: string
  limit?: number
  signal?: AbortSignal
}): Promise<HostedBoardChanges> {
  const search = new URLSearchParams()
  if (query.after) search.set('after', query.after)
  if (query.limit) search.set('limit', String(query.limit))
  const suffix = search.toString()
  return defaultRequest(
    `/v1/board/changes${suffix ? `?${suffix}` : ''}`,
    query.signal ? { signal: query.signal } : {},
  )
}

function recordApiBoardWatchClient(): Pick<RecordApiClient, RecordBoardWatchMethod> {
  return {
    releaseBoardTaskClaims: (input) =>
      defaultRequest('/v1/board/claims/release-task', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    openBoardStream: (signal) => fetchBoardStream(signal),
  }
}

function sourceFromBody(body: ReadableStream<Uint8Array>): RecordBoardStreamSource {
  const reader = body.getReader()
  return {
    async read() {
      const result = await reader.read()
      return result.done ? null : (result.value ?? new Uint8Array())
    },
  }
}

export function classifyBoardStreamResponse(
  status: number,
  body: ReadableStream<Uint8Array> | null,
  close: () => void,
): RecordBoardStreamOpen {
  if (status === 401 || status === 403) return { kind: 'unauthorized' }
  if (status !== 200 || !body) return { kind: 'error', reason: `record API ${status}` }
  return { kind: 'stream', source: sourceFromBody(body), close }
}

function releaseUnopenedStream(response: Response, connection: AbortController): void {
  try {
    if (response.body) void response.body.cancel()
  } finally {
    connection.abort()
  }
}

async function fetchBoardStream(signal?: AbortSignal): Promise<RecordBoardStreamOpen> {
  if (signal?.aborted) return { kind: 'error', reason: 'aborted' }
  const token = storedRecordToken()
  if (!token) return { kind: 'unauthorized' }
  const connection = new AbortController()
  const stop = () => connection.abort()
  signal?.addEventListener('abort', stop)
  const drop = () => signal?.removeEventListener('abort', stop)
  const close = () => {
    drop()
    connection.abort()
  }
  try {
    const response = await fetch(`${recordApiBaseUrl()}/v1/board/stream`, {
      method: 'GET',
      headers: boardStreamHeaders(token),
      signal: connection.signal,
    })
    const opened = classifyBoardStreamResponse(response.status, response.body, close)
    if (opened.kind !== 'stream') {
      releaseUnopenedStream(response, connection)
      drop()
    }
    return opened
  } catch (error) {
    connection.abort()
    drop()
    if (signal?.aborted) return { kind: 'error', reason: 'aborted' }
    return { kind: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
}

function boardStreamHeaders(token: string): Headers {
  const headers = new Headers()
  for (const [name, value] of bearerHeaders(token)) headers.set(name, value)
  headers.set('accept', 'text/event-stream')
  return headers
}
