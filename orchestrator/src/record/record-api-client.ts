// concern: record-api-client
/** HTTP client for the record API. Must not know SQL or local table shape. */

import { hostedApiFetch } from '../../../shared/bounded-fetch.ts'
import type {
  DocAudience,
  DocAudiences,
  DocForm,
  DocKind,
  DocStatus,
} from '../../../shared/docs.ts'
import { resolveRecordApiUrl } from '../../../shared/record-api-url.ts'
import { RECORD_SIGN_IN_REMEDY, recordUnreachableRefusal } from '../../../shared/record-remedies.ts'
import type { TableStorageMeasurement } from '../../../shared/storage-lifecycle.ts'
import type { CanonFinding } from '../canon/canon-lint.ts'
import type { DocGenerator } from '../doc/doc-generator.ts'
import type { DocDelivery, DocRevisionOp } from '../doc/doc-write-allowed.ts'
import type { VerdictInput } from '../verdict/verdict-payload.ts'
import { recordBoardRootClient } from './record-api-client-board.ts'
import {
  classifyBoardStreamResponse,
  releaseUnopenedStream,
} from './record-api-client-board-stream.ts'
import { type RecordChangesClient, recordChangesClient } from './record-api-client-changes.ts'
import { recordConfigAccessClient } from './record-api-client-config-access.ts'
import {
  recordApiUnreachable as classifyRecordApiUnreachable,
  recordApiError,
  recordAuthRefusal,
  recordAuthToken,
} from './record-api-client-error.ts'
import { type RecordLensClient, recordLensClient } from './record-api-client-lens.ts'
import { type RecordMachineClient, recordMachineClient } from './record-api-client-machine.ts'
import { recordModerationClient } from './record-api-client-moderation.ts'
import { recordOutsideClient } from './record-api-client-outside.ts'
import {
  boardClaimListPath,
  docSearchParams,
  type ProjectIdentityClient,
  projectIdentityClient,
  type RecordApiAuthentication,
  type RecordBoardMethod,
  type RecordBoardStreamOpen,
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
import { type RecordPortClient, recordPortClient } from './record-api-client-port.ts'
import { RecordApiRequestError, responseRecord } from './record-api-client-response.ts'

export { recordAuthRefusal, recordAuthToken } from './record-api-client-error.ts'
export { RecordApiRequestError } from './record-api-client-response.ts'

import { sendWithStoredRecordSessionToken } from '../../../shared/record-session.ts'
import {
  type RecordRoutingEvidenceClient,
  recordRoutingEvidenceClient,
} from './record-api-client-routing-evidence.ts'
import {
  recordIdentityResponse as parseRecordIdentityResponse,
  type RecordSessionClient,
  recordSessionClient,
} from './record-api-client-session.ts'
import type { RecordSettingsClient } from './record-api-client-settings.ts'
import { boardStreamHeaders, recordTransport } from './record-api-client-transport.ts'
import { type RecordWorkflowClient, recordWorkflowClient } from './record-api-client-workflow.ts'
import { bearerHeaders } from './record-auth.ts'
import {
  type HostedBoardAcceptInput,
  type HostedBoardChanges,
  type HostedBoardClaim,
  type HostedBoardFilingCompleteInput,
  type HostedBoardFilingFailInput,
  type HostedBoardMessage,
  type HostedBoardOverview,
  type HostedBoardOverviewFilters,
  type HostedBoardPostInput,
  type HostedBoardReceipt,
  type HostedBoardReceiptInput,
  type HostedBoardReplyInput,
  type HostedBoardSessionInput,
  type HostedBoardStatus,
  type HostedBoardSuccessorInput,
  type HostedBoardSuccessorResult,
  type HostedBoardTakeClaimInput,
  type HostedBoardThread,
  hostedBoardReplyBody,
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
import type { SnapshotKind } from './record-snapshots.ts'
import type { RecordSubject } from './record-subjects.ts'
import { trialSpaceDeleteTransport } from './record-trial-space-contract.ts'
import { currentRecordWriteDecision } from './record-write-authority.ts'

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
  sessionId?: string | null
  forceInject?: string
  op?: DocRevisionOp
  at?: string
  id?: string
  revisionId?: string
  expectedRevision?: string
  generator?: DocGenerator
}
type CreateOrganizationInput = { name: string; slug: string; metadata?: Record<string, unknown> }
type RecordDocImportResult = RecordDocWriteResponse<{ id: string; revisionIds: string[] }>
type RecordDocWriteContext = Pick<
  RecordDocUpsertInput,
  'reason' | 'author' | 'sessionId' | 'expectedRevision'
>

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
    id: string
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
  RecordChangesClient &
  RecordLensClient &
  RecordMachineClient &
  RecordSessionClient &
  RecordPortClient &
  RecordWorkflowClient &
  RecordSettingsClient &
  ReturnType<typeof recordModerationClient> &
  ReturnType<typeof recordOutsideClient> &
  ReturnType<typeof recordConfigAccessClient> & {
    storage(): Promise<{ tables: TableStorageMeasurement[] }>
    listRoutingEvidence: RecordRoutingEvidenceClient['listRoutingEvidence']
    createOrganization(input: CreateOrganizationInput): Promise<{ id: string; slug: string }>
    deleteTrialSpace(slug: string): Promise<ReturnType<typeof trialSpaceDeleteTransport.response>>
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
      unreadable?: Array<{ id: string; reason: string }>
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
      input: RecordDocWriteContext & { generator?: DocGenerator },
      destination?: RecordRequestDestination,
    ): Promise<{ id: string; revisionId: string }>
    consumeDoc(
      id: string,
      input: RecordDocWriteContext,
      destination?: RecordRequestDestination,
    ): Promise<{ id: string; revisionId: string; alreadyConsumed: boolean }>
    restoreDoc(
      id: string,
      input: RecordDocWriteContext & { revisionId: string },
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
    listBoardMessages(
      query?: HostedBoardOverviewFilters,
      signal?: AbortSignal,
    ): Promise<HostedBoardOverview>
    postBoardMessage(input: HostedBoardPostInput, signal?: AbortSignal): Promise<HostedBoardMessage>
    replyBoardMessage(rootId: string, input: HostedBoardReplyInput): Promise<HostedBoardMessage>
    withdrawBoardMessage(
      id: string,
      input?: HostedBoardSessionInput,
      signal?: AbortSignal,
    ): Promise<HostedBoardMessage>
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
      machineId?: string | null
      presence?: import('./record-board-contract.ts').HostedBoardPresenceInput[]
      signal?: AbortSignal
    }): Promise<HostedBoardChanges>
    takeBoardSuccessor(input: HostedBoardSuccessorInput): Promise<HostedBoardSuccessorResult>
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

const injectedClient = (): RecordApiClient | null => injectSlot().current
export const recordApiClientInjected = (): boolean => injectedClient() !== null

const recordApiUnreachable = (error: unknown, origin = recordApiBaseUrl()) =>
  classifyRecordApiUnreachable(error, origin)

export const recordIdentityResponse = (body: unknown) =>
  parseRecordIdentityResponse(body, (message) => recordApiUnreachable(new Error(message)))

async function recordEmailAuthRequest(
  path: '/api/auth/sign-in/email' | '/api/auth/sign-up/email',
  body: Record<string, string>,
) {
  const origin = recordApiBaseUrl()
  let response: Response
  try {
    response = await recordTransport(origin, path, {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw classifyRecordApiUnreachable(error, origin, 'non-idempotent')
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw recordAuthRefusal(response.status, payload, response.headers)
  const token = recordAuthToken(response.headers, payload)
  const user = responseRecord(payload).user
  if (!token || !user || typeof user !== 'object') throw new Error(RECORD_SIGN_IN_REMEDY)
  return { token, user: user as Record<string, unknown> }
}

export type RecordSessionResult = { token: string; user: Record<string, unknown> }

export const recordApiSignIn = (email: string, password: string): Promise<RecordSessionResult> =>
  recordEmailAuthRequest('/api/auth/sign-in/email', { email, password })

export const recordApiSignUp = (
  email: string,
  name: string,
  password: string,
): Promise<RecordSessionResult> =>
  recordEmailAuthRequest('/api/auth/sign-up/email', { email, name, password })

export function recordApiBaseUrl(
  environment: Record<string, string | undefined> = process.env,
): string {
  const url = resolveRecordApiUrl(environment)
  if (
    environment.NODE_ENV === 'test' &&
    !environment.BOTTEGA_TEST_POSTGRES_CONTAINER &&
    !injectedClient()
  )
    throw new Error('record API client refuses a real base URL unless a stub is injected in tests')
  return url.replace(/\/$/, '')
}

export async function recordApiRequest<T>(
  path: string,
  init: RequestInit & {
    schema?: (body: unknown) => T
    acceptedError?: { status: number; schema: (body: unknown) => T }
    destinationSpaceId?: string
  } = {},
  authentication?: RecordApiAuthentication,
  transport: typeof fetch = hostedApiFetch,
): Promise<T> {
  throwIfRecordApiRequestRefused()
  const readToken = async () =>
    init.signal
      ? await (authentication
          ? authentication.tokenAsync(init.signal)
          : storedRecordTokenAsync(undefined, init.signal))
      : authentication
        ? authentication.token()
        : storedRecordToken()
  const origin = recordApiBaseUrl()
  const send = async (bearer: string) => {
    const headers = new Headers(init.headers)
    for (const [name, value] of bearerHeaders(bearer)) headers.set(name, value)
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    if (init.destinationSpaceId) headers.set('x-record-space', init.destinationSpaceId)
    try {
      return await recordTransport(origin, path, { ...init, headers }, transport)
    } catch (error) {
      const method = init.method?.toUpperCase() ?? 'GET'
      throw classifyRecordApiUnreachable(
        error,
        origin,
        method === 'GET' || method === 'HEAD' ? 'probe' : 'non-idempotent',
      )
    }
  }
  const sendStored = async (token: string | null) => {
    if (!token) throw new RecordApiRequestError(RECORD_SIGN_IN_REMEDY, 'refused')
    return send(token)
  }
  const response = authentication
    ? await sendStored(await readToken())
    : await sendWithStoredRecordSessionToken(sendStored, {
        signal: init.signal ?? undefined,
        readToken,
      })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    if (init.acceptedError?.status === response.status) return init.acceptedError.schema(body)
    throw recordApiError(body, response.status, response.headers)
  }
  return (init.schema ? init.schema(body) : (body as T)) as T
}

function throwIfRecordApiRequestRefused(): void {
  const authority = currentRecordWriteDecision()
  if (authority.verdict === 'refused') {
    throw new RecordApiRequestError(authority.refusal, 'refused')
  }
}

async function publicRequest<T>(path: string): Promise<T> {
  let response: Response
  try {
    response = await recordTransport(recordApiBaseUrl(), path, {
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
  const body = await recordApiRequest<{ items?: Record<string, unknown>[] }>(
    `/v1/docs/${id}/revisions`,
    destination,
  )
  return Array.isArray(body) ? body : (body.items ?? [])
}

const reorderDocsRequest: RecordApiClient['reorderDocs'] = (input, destination) =>
  recordApiRequest('/v1/docs/order', {
    method: 'PUT',
    body: JSON.stringify(input),
    ...destination,
  })
export function authenticatedRecordApiClient(
  authentication: RecordApiAuthentication,
): RecordApiClient {
  return recordApiClient((path, init) => recordApiRequest(path, init, authentication))
}

export function recordApiClient(request = recordApiRequest): RecordApiClient {
  const injected = injectedClient()
  if (injected) return injected
  if (process.env.NODE_ENV === 'test' && !process.env.BOTTEGA_TEST_POSTGRES_CONTAINER)
    throw new Error('record API client refuses a real base URL unless a stub is injected in tests')
  return {
    storage: () => request('/v1/storage'),
    ...recordChangesClient(request),
    ...recordMachineClient(request),
    ...recordConfigAccessClient(request),
    ...recordModerationClient(request),
    ...recordOutsideClient(request),
    ...recordSessionClient(request, recordIdentityResponse),
    ...recordIdentityAndSpaceClient(request),
    ...recordSnapshotAndPublicDocClient(request),
    ...recordDocReadClient(request),
    ...recordDocWriteClient(request),
    ...recordLensClient(request),
    ...recordPortClient(request),
    ...recordWorkflowClient(request),
    ...projectIdentityClient(request),
    ...recordProjectSubjectClient(request),
    ...recordRunClient(request),
    ...recordRoutingEvidenceClient(request),
    ...recordBoardClient(request),
    ...recordApiBoardWatchClient(),
  }
}

const recordSnapshotAndPublicDocClient = (
  request = recordApiRequest,
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
  request = recordApiRequest,
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
  request = recordApiRequest,
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
  applySettingsAutoMode: (input, destination) =>
    request('/v1/settings/auto-mode', {
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
  request = recordApiRequest,
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

const recordRunClient = (request = recordApiRequest): Pick<RecordApiClient, RecordRunMethod> => ({
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

const recordBoardClient = (
  request = recordApiRequest,
): Pick<RecordApiClient, RecordBoardMethod> => ({
  ...recordBoardRootClient(request),
  replyBoardMessage: (rootId, input) =>
    request(`/v1/board/messages/${rootId}/replies`, {
      method: 'POST',
      body: hostedBoardReplyBody(input),
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
  takeBoardSuccessor: (input) =>
    request('/v1/board/successor', { method: 'PUT', body: JSON.stringify(input) }),
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
  request = recordApiRequest,
): Pick<RecordApiClient, RecordIdentityAndSpaceMethod> {
  return {
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
    deleteTrialSpace: (slug) =>
      request('/v1/spaces/delete-trial', trialSpaceDeleteTransport.options(slug)),
  }
}

function recordApiBoardWatchClient(): Pick<RecordApiClient, RecordBoardWatchMethod> {
  return {
    releaseBoardTaskClaims: (input) =>
      recordApiRequest('/v1/board/claims/release-task', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    openBoardStream: (signal) => fetchBoardStream(signal),
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
  let origin: string | null = null
  try {
    throwIfRecordApiRequestRefused()
    origin = recordApiBaseUrl()
    // The stream is unbounded until a streaming budget exists.
    const response = await recordTransport(
      origin,
      '/v1/board/stream',
      {
        method: 'GET',
        headers: boardStreamHeaders(token),
        signal: connection.signal,
      },
      ((url, init) => fetch(url, init)) as typeof fetch,
    )
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
    const detail = error instanceof Error ? error.message : String(error)
    return {
      kind: 'error',
      reason: origin ? recordUnreachableRefusal(origin, detail, 'probe') : detail,
    }
  }
}
