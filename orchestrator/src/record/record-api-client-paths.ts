// concern: record-api-client
/** Builds project-bearing record request bodies and paths without transport state. */

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
  listProjects(destination?: RecordRequestDestination): Promise<
    Array<{
      id: string
      name: string
      spaceId: string
      spaceName: string
      stack: string | null
      canon: boolean
      settings: Record<string, unknown>
      retiredAt: string | null
    }>
  >
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

export function projectIdentityClient(request: RecordClientRequest): ProjectIdentityClient {
  return {
    upsertProject: (input, destination) =>
      request<{ id: string; name: string }>('/v1/projects', {
        method: 'PUT',
        body: JSON.stringify(input),
        ...destination,
      }),
    listProjects: (destination) =>
      request<Awaited<ReturnType<ProjectIdentityClient['listProjects']>>>(
        '/v1/projects',
        destination,
      ),
    retireProject: (id, destination) =>
      request<{ name: string }>(`/v1/projects/${encodeURIComponent(id)}/retire`, {
        method: 'POST',
        ...destination,
      }),
  }
}
