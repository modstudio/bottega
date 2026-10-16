// concern: record-api-client
/** Builds project-bearing record request bodies and paths without transport state. */

export type RecordRequestDestination = { destinationSpaceId?: string }

export type ProjectIdentityClient = {
  upsertProject(
    input: {
      id?: string
      name: string
      previousName?: string
      path: string
      stack: string | null
      canon: boolean
      settings: Record<string, unknown>
      retiredAt: string | null
    },
    destination?: RecordRequestDestination,
  ): Promise<{ id: string; name: string }>
  listProjects(
    destination?: RecordRequestDestination,
  ): Promise<Array<{ id: string; name: string; spaceId: string }>>
  retireProject(name: string, destination?: RecordRequestDestination): Promise<{ name: string }>
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
      request<Array<{ id: string; name: string; spaceId: string }>>('/v1/projects', destination),
    retireProject: (name, destination) =>
      request<{ name: string }>(`/v1/projects/${encodeURIComponent(name)}/retire`, {
        method: 'POST',
        ...destination,
      }),
  }
}
