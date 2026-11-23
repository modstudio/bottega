// concern: record-api-client
/** Builds project-bearing record request bodies and paths without transport state. */

import type { DocAudience } from '../../../shared/docs.ts'
import {
  type RecordProject,
  RecordProjectsSchema,
} from '../../../shared/record-project-contract.ts'
import type { RecordProjectPurgeResult } from './record-project-purge-contract.ts'

export const RECORD_CONTEXT_ITEMS_ROUTE = '/v1/context-items'
export const RECORD_SPACE_AGENTS_ROUTE = '/v1/space-agents'
export const RECORD_CONTEXT_ITEM_HOLDERS_ROUTE = '/v1/context-items/holders'
export const CONTEXT_ITEM_HOLDER_BATCH_LIMIT = 100

export type RecordRequestDestination = { destinationSpaceId?: string }
export type RecordWriteDestination = { destinationSpaceId: string }
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
export type RecordDocReadMethod =
  | 'searchDocs'
  | 'listDocs'
  | 'getDoc'
  | 'getDocRevision'
  | 'listRevisions'
export type RecordDocWriteMethod =
  | 'upsertDoc'
  | 'reorderDocs'
  | 'applySettingsPermission'
  | 'applySettingsAutoMode'
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
export type RecordIdentityAndSpaceMethod =
  | 'createOrganization'
  | 'deleteTrialSpace'
  | 'deleteSpace'
  | 'setActiveOrganization'
  | 'listInvitations'
  | 'acceptInvitation'
  | 'inviteMember'
  | 'removeMember'
export type RecordBoardWatchMethod = 'openBoardStream'
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
      expectedRevision?: number | null
    },
    destination: RecordWriteDestination,
  ): Promise<{ id: string; name: string; revision?: number }>
  listProjects(destination?: RecordRequestDestination): Promise<RecordProject[]>
  retireProject(
    id: string,
    destination: RecordWriteDestination,
  ): Promise<{ name: string; revision?: number }>
  purgeProject(
    id: string,
    confirmation: string,
    destination: RecordWriteDestination,
  ): Promise<RecordProjectPurgeResult>
}

export type RecordClientRequest = <T>(
  path: string,
  init?: RequestInit & {
    schema?: (body: unknown) => T
    acceptedError?: { status: number; schema: (body: unknown) => T }
    destinationSpaceId?: string
  },
) => Promise<T>

export function subjectMutationBody(
  input: { project: string; projectId?: string | null },
  change: Record<string, string>,
): string {
  return JSON.stringify({ project: input.project, projectId: input.projectId, ...change })
}

export type BoardClaimListOptions = { openOnly?: boolean }

export function boardClaimListPath(
  project: string,
  projectId?: string | null,
  options?: BoardClaimListOptions,
): string {
  const search = new URLSearchParams({ project })
  if (projectId) search.set('projectId', projectId)
  if (options?.openOnly) search.set('openOnly', 'true')
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

export function workflowCataloguePath(
  table: string,
  query: { limit?: number; cursor?: string },
): string {
  const search = new URLSearchParams()
  if (query.limit) search.set('limit', String(query.limit))
  if (query.cursor) search.set('cursor', query.cursor)
  const suffix = search.toString()
  return `/v1/workflow-catalogue/${encodeURIComponent(table)}${suffix ? `?${suffix}` : ''}`
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
      request<{ id: string; name: string; revision?: number }>('/v1/projects', {
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
      request<{ name: string; revision: number }>(`/v1/projects/${encodeURIComponent(id)}/retire`, {
        method: 'POST',
        ...destination,
      }),
    purgeProject: (id, confirmation, destination) =>
      request<RecordProjectPurgeResult>(`/v1/projects/${encodeURIComponent(id)}/purge`, {
        method: 'POST',
        body: JSON.stringify({ confirmation }),
        ...destination,
      }),
  }
}
