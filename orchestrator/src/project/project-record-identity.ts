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
  source: 'hosted' | 'created' | 'local'
}

export type ProjectRecordIdDecision =
  | { kind: 'already-filled' }
  | { kind: 'use-hosted'; recordId: string }
  | { kind: 'create-hosted' }
  | { kind: 'mint-local' }

/** Decide identity provenance without performing either hosted or local I/O. */
export function decideProjectRecordId(input: {
  recordId: string | null
  hostedRecordId: string | null
  retired: boolean
}): ProjectRecordIdDecision {
  if (input.recordId) return { kind: 'already-filled' }
  if (input.hostedRecordId) return { kind: 'use-hosted', recordId: input.hostedRecordId }
  if (input.retired) return { kind: 'mint-local' }
  return { kind: 'create-hosted' }
}

/** Fill only missing identities; existing local identities are never name-matched again. */
export async function fillProjectRecordIds(): Promise<FilledProjectRecordId[]> {
  requireHostedRecord(`${PLATFORM_SLUG} project fill-record-ids`)
  const client = recordApiClient()
  const filled: FilledProjectRecordId[] = []
  for (const project of [...projects(), ...projects({ retired: true })]) {
    const localDecision = decideProjectRecordId({
      recordId: project.recordId,
      hostedRecordId: null,
      retired: Boolean(project.retiredAt),
    })
    if (localDecision.kind === 'already-filled') continue
    const destinationSpaceId = await requireProjectRecordDestination(
      project.name,
      project.settings,
      client,
    )
    const destination = { destinationSpaceId }
    const hosted = (await client.listProjects(destination)).find(
      (candidate) => candidate.name === project.name,
    )
    const decision = decideProjectRecordId({
      recordId: project.recordId,
      hostedRecordId: hosted?.id ?? null,
      retired: Boolean(project.retiredAt),
    })
    if (decision.kind === 'already-filled') continue
    let recordId: string
    let source: FilledProjectRecordId['source']
    if (decision.kind === 'use-hosted') {
      recordId = decision.recordId
      source = 'hosted'
    } else if (decision.kind === 'mint-local') {
      recordId = newRecordId()
      source = 'local'
    } else {
      const result = await client.upsertProject(
        {
          id: newRecordId(),
          name: project.name,
          path: project.path,
          stack: project.stack,
          canon: project.canon,
          settings: project.settings,
          retiredAt: project.retiredAt,
        },
        destination,
      )
      recordId = result.id
      source = 'created'
    }
    storeProjectRecordId(project.id, recordId)
    filled.push({
      name: project.name,
      recordId,
      source,
    })
  }
  return filled
}
