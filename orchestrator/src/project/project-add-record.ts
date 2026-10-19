// concern: project-add-record
/** Reads hosted project facts and applies the pure project-add decision. */

import type { RecordSpaceMembership } from '../../../shared/record-space-membership.ts'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import { noActiveRecordSpaceRefusal } from '../record/record-project-destination.ts'
import {
  BOUND_RECORD_WRITE_REFUSAL,
  currentRecordWriteDecision,
} from '../record/record-write-authority.ts'
import { type AddProjectDecision, decideProjectAdd } from './project-add-decision.ts'
import type { ProjectSettings } from './project-settings.ts'

export type ProjectAddRecordDecision = {
  decision: AddProjectDecision
  targetSpace?: { id: string; label: string }
}

function membershipTarget(
  membership: RecordSpaceMembership | undefined,
): ProjectAddRecordDecision['targetSpace'] {
  return membership ? { id: membership.spaceId, label: membership.slug } : undefined
}

export async function projectAddDecision(input: {
  name: string
  requestedStack: string | null
  stackWasRequested: boolean
  requestedSettings: ProjectSettings
  selectedSpace?: string
}): Promise<ProjectAddRecordDecision> {
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
  })
  if (decision.kind === 'refuse') return { decision }
  if (decision.kind === 'adopt') {
    const hosted = hostedProjects.find((project) => project.id === decision.recordId)!
    return {
      decision,
      targetSpace: { id: hosted.spaceId, label: decision.space },
    }
  }
  const selected = input.selectedSpace
    ? memberships.find(
        (membership) =>
          membership.spaceId === input.selectedSpace || membership.slug === input.selectedSpace,
      )
    : undefined
  const declared = input.requestedSettings.space
    ? memberships.find(
        (membership) =>
          membership.spaceId === input.requestedSettings.space ||
          membership.slug === input.requestedSettings.space,
      )
    : undefined
  const requestedTarget = membershipTarget(selected ?? declared)
  if (requestedTarget) return { decision, targetSpace: requestedTarget }
  if (!identity.activeSpaceId) throw new Error(noActiveRecordSpaceRefusal())
  return {
    decision,
    targetSpace: {
      id: identity.activeSpaceId,
      label:
        memberships.find((membership) => membership.spaceId === identity.activeSpaceId)?.slug ??
        identity.activeSpaceId,
    },
  }
}
