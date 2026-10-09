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
    return (await hostedSubjectClient(input.project)).addProjectSubject(input)
  },
  async rename(project: string, id: string, name: string) {
    return (await hostedSubjectClient(project)).renameProjectSubject({ project, id, name })
  },
  async define(project: string, id: string, definition: string) {
    return (await hostedSubjectClient(project)).defineProjectSubject({ project, id, definition })
  },
  async reorder(project: string, ids: string[]) {
    const result = await (await hostedSubjectClient(project)).reorderProjectSubjects({
      project,
      ids,
    })
    return result.items
  },
  async retire(project: string, id: string) {
    return (await hostedSubjectClient(project)).retireProjectSubject({ project, id })
  },
}
