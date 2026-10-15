// concern: project-record-identity
/** Fills the one sanctioned project-name match from the hosted record. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import { requireProjectRecordDestination } from '../record/record-project-destination-client.ts'
import { requireHostedRecord } from '../record/record-write-authority.ts'
import { projects, storeProjectRecordId } from './projects.ts'

export type FilledProjectRecordId = {
  name: string
  recordId: string
  source: 'hosted' | 'created'
}

/** Fill only missing identities; existing local identities are never name-matched again. */
export async function fillProjectRecordIds(): Promise<FilledProjectRecordId[]> {
  requireHostedRecord(`${PLATFORM_SLUG} project fill-record-ids`)
  const client = recordApiClient()
  const filled: FilledProjectRecordId[] = []
  for (const project of [...projects(), ...projects({ retired: true })]) {
    if (project.recordId) continue
    const destinationSpaceId = await requireProjectRecordDestination(
      project.name,
      project.settings,
      client,
    )
    const destination = { destinationSpaceId }
    const hosted = (await client.listProjects(destination)).find(
      (candidate) => candidate.name === project.name,
    )
    const proposedId = hosted?.id ?? newRecordId()
    const result = hosted
      ? hosted
      : await client.upsertProject(
          {
            id: proposedId,
            name: project.name,
            path: project.path,
            stack: project.stack,
            canon: project.canon,
            settings: project.settings,
            retiredAt: project.retiredAt,
          },
          destination,
        )
    storeProjectRecordId(project.name, result.id)
    filled.push({
      name: project.name,
      recordId: result.id,
      source: hosted ? 'hosted' : 'created',
    })
  }
  return filled
}
