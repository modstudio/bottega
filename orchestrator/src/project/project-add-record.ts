// concern: project-add-record
/** Reads hosted project facts and applies the pure project-add decision. */

import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import {
  BOUND_RECORD_WRITE_REFUSAL,
  currentRecordWriteDecision,
} from '../record/record-write-authority.ts'
import {
  decideProjectAdd,
  type ProjectAddDecisionResult,
} from './project-add-decision.ts'
import type { ProjectSettings } from './project-settings.ts'

export async function projectAddDecision(input: {
  name: string
  requestedStack: string | null
  stackWasRequested: boolean
  requestedSettings: ProjectSettings
  selectedSpace?: string
}): Promise<ProjectAddDecisionResult> {
  const authority = currentRecordWriteDecision()
  if (authority === 'refused') throw new Error(BOUND_RECORD_WRITE_REFUSAL)
  if (authority === 'local-authoritative') {
    return { decision: { kind: 'mint', settings: input.requestedSettings } }
  }
  const client = recordApiClient()
  const identity = await client.whoami()
  const memberships = parseRecordSpaceMemberships(identity.memberships)
  const hostedProjects = (
    await Promise.all(
      memberships.map((membership) =>
        client.listProjects({ destinationSpaceId: membership.spaceId }),
      ),
    )
  ).flat()
  const decision = decideProjectAdd({
    ...input,
    hostedProjects,
    memberships,
    activeSpaceId: identity.activeSpaceId,
  })
  return decision
}
