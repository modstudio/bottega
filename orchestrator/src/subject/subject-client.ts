// concern: subject-client
/** Binds subject requests to a project's declared record destination. */
import { projectRowByName } from '../project/projects.ts'
import { type RecordApiClient, recordApiClient } from '../record/record-api-client.ts'
import { requireProjectRecordDestination } from '../record/record-project-destination-client.ts'

type SubjectClient = Pick<
  RecordApiClient,
  | 'addProjectSubject'
  | 'renameProjectSubject'
  | 'defineProjectSubject'
  | 'reorderProjectSubjects'
  | 'retireProjectSubject'
>

function withProjectId<T extends { project: string }>(input: T): T & { projectId: string | null } {
  return { ...input, projectId: projectRowByName(input.project)?.recordId ?? null }
}

async function hostedSubjectClient(project: string): Promise<SubjectClient> {
  const client = recordApiClient()
  const destination = {
    destinationSpaceId: await requireProjectRecordDestination(
      project,
      projectRowByName(project)?.settings,
      client,
    ),
  }
  return {
    addProjectSubject: (input) => client.addProjectSubject(input, destination),
    renameProjectSubject: (input) => client.renameProjectSubject(input, destination),
    defineProjectSubject: (input) => client.defineProjectSubject(input, destination),
    reorderProjectSubjects: (input) => client.reorderProjectSubjects(input, destination),
    retireProjectSubject: (input) => client.retireProjectSubject(input, destination),
  }
}

export const subjectClient = {
  async add(input: { id: string; project: string; name: string; definition: string }) {
    return (await hostedSubjectClient(input.project)).addProjectSubject(withProjectId(input))
  },
  async rename(project: string, id: string, name: string) {
    return (await hostedSubjectClient(project)).renameProjectSubject(
      withProjectId({ project, id, name }),
    )
  },
  async define(project: string, id: string, definition: string) {
    return (await hostedSubjectClient(project)).defineProjectSubject(
      withProjectId({ project, id, definition }),
    )
  },
  async reorder(project: string, ids: string[]) {
    const result = await (await hostedSubjectClient(project)).reorderProjectSubjects(
      withProjectId({ project, ids }),
    )
    return result.items
  },
  async retire(project: string, id: string) {
    return (await hostedSubjectClient(project)).retireProjectSubject(withProjectId({ project, id }))
  },
}
