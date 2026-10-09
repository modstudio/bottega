// concern: subject-client
/** Binds subject requests to a project's declared record destination. */
import { projectRowByName } from '../project/projects.ts'
import {
  type RecordRequestDestination,
  recordApiClient,
  recordApiRequest,
} from '../record/record-api-client.ts'
import { requireProjectRecordDestination } from '../record/record-project-destination-client.ts'
import type { RecordSubject } from '../record/record-subjects.ts'

export type SubjectPage = { items: RecordSubject[]; nextCursor: string | null }
type SubjectCursor = { at: string; id: string }

const destination = async (project: string): Promise<RecordRequestDestination> => ({
  destinationSpaceId: await requireProjectRecordDestination(
    project,
    projectRowByName(project)?.settings,
    recordApiClient(),
  ),
})

export const subjectClient = {
  async list(
    project: string,
    query: {
      includeRetired?: boolean
      order?: 'catalog' | 'updated'
      cursor?: SubjectCursor
      limit?: number
    } = {},
    explicitDestination?: RecordRequestDestination,
  ): Promise<SubjectPage> {
    const search = new URLSearchParams({ project })
    if (query.includeRetired) search.set('includeRetired', 'true')
    if (query.order) search.set('order', query.order)
    if (query.cursor) search.set('cursor', btoa(JSON.stringify(query.cursor)))
    if (query.limit) search.set('limit', String(query.limit))
    const target = explicitDestination ?? (await destination(project))
    const injected = recordApiClient().listProjectSubjects
    return injected
      ? injected({ project, ...query }, target)
      : recordApiRequest(`/v1/subjects?${search}`, target)
  },
  async listSpace(
    destinationSpaceId: string,
    query: { cursor?: SubjectCursor; limit?: number } = {},
  ): Promise<SubjectPage> {
    const search = new URLSearchParams({ includeRetired: 'true', order: 'updated' })
    if (query.cursor) search.set('cursor', btoa(JSON.stringify(query.cursor)))
    if (query.limit) search.set('limit', String(query.limit))
    const injected = recordApiClient().listProjectSubjects
    return injected
      ? injected({ includeRetired: true, order: 'updated', ...query }, { destinationSpaceId })
      : recordApiRequest(`/v1/subjects?${search}`, { destinationSpaceId })
  },
  async add(input: { id: string; project: string; name: string; definition: string }) {
    const injected = recordApiClient().addProjectSubject
    if (injected) return injected(input, await destination(input.project))
    return recordApiRequest<RecordSubject>('/v1/subjects', {
      method: 'PUT',
      body: JSON.stringify(input),
      ...(await destination(input.project)),
    })
  },
  async rename(project: string, id: string, name: string) {
    const injected = recordApiClient().renameProjectSubject
    if (injected) return injected({ project, id, name }, await destination(project))
    return recordApiRequest<RecordSubject>(`/v1/subjects/${id}/rename`, {
      method: 'POST',
      body: JSON.stringify({ project, name }),
      ...(await destination(project)),
    })
  },
  async define(project: string, id: string, definition: string) {
    const injected = recordApiClient().defineProjectSubject
    if (injected) return injected({ project, id, definition }, await destination(project))
    return recordApiRequest<RecordSubject>(`/v1/subjects/${id}/define`, {
      method: 'POST',
      body: JSON.stringify({ project, definition }),
      ...(await destination(project)),
    })
  },
  async reorder(project: string, ids: string[]) {
    const injected = recordApiClient().reorderProjectSubjects
    const result = injected
      ? await injected({ project, ids }, await destination(project))
      : await recordApiRequest<{ items: RecordSubject[] }>('/v1/subjects/reorder', {
          method: 'POST',
          body: JSON.stringify({ project, ids }),
          ...(await destination(project)),
        })
    return result.items
  },
  async retire(project: string, id: string) {
    const injected = recordApiClient().retireProjectSubject
    if (injected) return injected({ project, id }, await destination(project))
    return recordApiRequest<RecordSubject>(`/v1/subjects/${id}/retire`, {
      method: 'POST',
      body: JSON.stringify({ project }),
      ...(await destination(project)),
    })
  },
}
