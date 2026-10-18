// concern: record-api-client
/** Builds project-bearing record request bodies and paths without transport state. */

import type { DocAudience } from '../../../shared/docs.ts'
import {
  type RecordProject,
  RecordProjectsSchema,
} from '../../../shared/record-project-contract.ts'

export type RecordRequestDestination = { destinationSpaceId?: string }
export type RecordApiAuthentication = {
  token(): string | null
  tokenAsync(signal: AbortSignal): Promise<string | null>
}
export type RecordBoardStreamSource = {
  read(): Promise<Uint8Array | null>
}
export type RecordBoardStreamOpen =
  | { kind: 'stream'; source: RecordBoardStreamSource; close: () => void }
  | { kind: 'unauthorized' }
  | { kind: 'error'; reason: string }
export type RecordDocOrderInput = {
  scope: string
  subject: string | null
  parentId: string | null
  orderedIds: string[]
}

export type RecordSnapshotAndPublicDocMethod =
  | 'putSnapshot'
  | 'listSnapshots'
  | 'listPublicDocs'
  | 'getPublicDoc'
  | 'searchPublicDocs'
export type RecordDocReadMethod = 'searchDocs' | 'listDocs' | 'getDoc' | 'listRevisions'
export type RecordDocWriteMethod =
  | 'upsertDoc'
  | 'reorderDocs'
  | 'applySettingsPermission'
  | 'importDoc'
  | 'importCanon'
  | 'deleteDoc'
  | 'consumeDoc'
  | 'restoreDoc'
  | 'renameSubject'
export type RecordProjectSubjectMethod =
  | 'listProjectSubjects'
  | 'addProjectSubject'
  | 'renameProjectSubject'
  | 'defineProjectSubject'
  | 'reorderProjectSubjects'
  | 'retireProjectSubject'
export type RecordRunMethod = 'putScore' | 'voidRun' | 'unvoidRun' | 'listScores' | 'counts'
export type RecordBoardMethod =
  | 'listBoardMessages'
  | 'postBoardMessage'
  | 'replyBoardMessage'
  | 'withdrawBoardMessage'
  | 'acceptBoardAnswer'
  | 'takeBoardFilingLease'
  | 'completeBoardFilingLease'
  | 'failBoardFilingLease'
  | 'getBoardThread'
  | 'getBoardStatus'
  | 'putBoardReceipt'
  | 'listBoardChanges'
  | 'takeBoardClaim'
  | 'renewBoardClaim'
  | 'releaseBoardClaim'
  | 'listBoardClaims'
export type RecordIdentityAndSpaceMethod =
  | 'whoami'
  | 'sync'
  | 'createOrganization'
  | 'setActiveOrganization'
  | 'listInvitations'
  | 'acceptInvitation'
  | 'inviteMember'
export type RecordBoardWatchMethod = 'releaseBoardTaskClaims' | 'openBoardStream'

export type ProjectIdentityClient = {
  upsertProject(
    input: {
      id: string
      name: string
      path: string
      stack: string | null
      canon: boolean
      settings: Record<string, unknown>
      retiredAt: string | null
    },
    destination?: RecordRequestDestination,
  ): Promise<{ id: string; name: string }>
  listProjects(destination?: RecordRequestDestination): Promise<RecordProject[]>
  retireProject(id: string, destination?: RecordRequestDestination): Promise<{ name: string }>
}

type RecordClientRequest = <T>(
  path: string,
  init?: RequestInit & { schema?: (body: unknown) => T; destinationSpaceId?: string },
) => Promise<T>

export function subjectMutationBody(
  input: { project: string; projectId?: string | null },
  change: Record<string, string>,
): string {
  return JSON.stringify({ project: input.project, projectId: input.projectId, ...change })
}

export function boardClaimListPath(project: string, projectId?: string | null): string {
  const search = new URLSearchParams({ project })
  if (projectId) search.set('projectId', projectId)
  return `/v1/board/claims?${search}`
}

export function lensCataloguePath(
  table: string,
  query: { limit?: number; cursor?: string },
): string {
  const search = new URLSearchParams()
  if (query.limit) search.set('limit', String(query.limit))
  if (query.cursor) search.set('cursor', query.cursor)
  const suffix = search.toString()
  return `/v1/lens-catalogue/${encodeURIComponent(table)}${suffix ? `?${suffix}` : ''}`
}

export function docSearchParams(query: {
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

export function projectIdentityClient(request: RecordClientRequest): ProjectIdentityClient {
  return {
    upsertProject: (input, destination) =>
      request<{ id: string; name: string }>('/v1/projects', {
        method: 'PUT',
        body: JSON.stringify(input),
        ...destination,
      }),
    listProjects: (destination) =>
      request<Awaited<ReturnType<ProjectIdentityClient['listProjects']>>>('/v1/projects', {
        ...destination,
        schema: (body) => RecordProjectsSchema.parse(body),
      }),
    retireProject: (id, destination) =>
      request<{ name: string }>(`/v1/projects/${encodeURIComponent(id)}/retire`, {
        method: 'POST',
        ...destination,
      }),
  }
}
