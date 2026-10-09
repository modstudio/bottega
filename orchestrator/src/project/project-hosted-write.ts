// concern: project-hosted-write
/** Applies project-register write authority at the hosted-record boundary. */

import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import {
  declaredRecordSpace,
  recordSpaceMembershipRefusal,
} from '../record/record-project-destination.ts'
import {
  projectDestinationFromIdentity,
  requireProjectRecordDestination,
} from '../record/record-project-destination-client.ts'
import {
  applyRecordWriteAuthority,
  BOUND_RECORD_WRITE_REFUSAL,
  currentRecordWriteDecision,
  requireHostedRecord,
} from '../record/record-write-authority.ts'
import type { ProjectSettings, StoredProjectSettings } from './project-settings.ts'

export async function writeProjectToHostedRecord(
  p: {
    name: string
    previousName?: string
    path: string
    stack?: string | null
    canon?: boolean
    settings?: ProjectSettings | StoredProjectSettings
    retiredAt?: string | null
  },
  destinationSpaceId?: string,
): Promise<void> {
  await applyRecordWriteAuthority({
    local: () => undefined,
    hosted: async () => {
      const client = recordApiClient()
      const destination =
        destinationSpaceId ?? (await requireProjectRecordDestination(p.name, p.settings, client))
      return client.upsertProject(
        {
          name: p.name,
          previousName: p.previousName,
          path: p.path.replace(/\/$/, ''),
          stack: p.stack ?? null,
          canon: Boolean(p.canon),
          settings: p.settings ?? {},
          retiredAt: p.retiredAt ?? null,
        },
        { destinationSpaceId: destination },
      )
    },
  })
}

export async function retireProjectInHostedRecord(
  name: string,
  settings: ProjectSettings | StoredProjectSettings,
): Promise<void> {
  await applyRecordWriteAuthority({
    local: () => undefined,
    hosted: async () => {
      const client = recordApiClient()
      const destinationSpaceId = await requireProjectRecordDestination(name, settings, client)
      return client.retireProject(name, { destinationSpaceId })
    },
  })
}

export type HostedProjectDestination = {
  destinationSpaceId: string
  memberships: ReturnType<typeof parseRecordSpaceMemberships>
}

export async function hostedProjectDestination(
  project: string,
  settings: ProjectSettings | StoredProjectSettings,
): Promise<HostedProjectDestination | undefined> {
  const authority = currentRecordWriteDecision()
  if (authority === 'refused') throw new Error(BOUND_RECORD_WRITE_REFUSAL)
  if (authority === 'local-authoritative') return undefined
  const identity = await recordApiClient().whoami()
  const decision = projectDestinationFromIdentity(project, settings, identity)
  if ('refused' in decision) throw new Error(recordSpaceMembershipRefusal(decision.declaredSpace))
  return {
    destinationSpaceId: decision.spaceId,
    memberships: parseRecordSpaceMemberships(identity.memberships),
  }
}

export async function refuseHostedProjectSpaceChange(
  project: { name: string; settings: ProjectSettings | StoredProjectSettings },
  nextSettings: ProjectSettings | StoredProjectSettings,
  destination: HostedProjectDestination | undefined,
): Promise<void> {
  if (declaredRecordSpace(project.settings) === declaredRecordSpace(nextSettings)) return
  if (!destination) return
  await applyRecordWriteAuthority({
    local: () => undefined,
    hosted: async () => {
      const client = recordApiClient()
      for (const membership of destination.memberships) {
        if (membership.spaceId === destination.destinationSpaceId) continue
        const rows = await client.listProjects({ destinationSpaceId: membership.spaceId })
        const row = rows.find((candidate) => candidate.name === project.name)
        if (row) {
          const rowSpace = destination.memberships.find(
            (candidate) => candidate.spaceId === row.spaceId,
          )
          throw new Error(
            `project ${project.name} already has a hosted row in record space ${rowSpace?.slug ?? row.spaceId}; run \`orch record space move-project\` before changing settings.space`,
          )
        }
      }
    },
  })
}

export function requireHostedProjectPush(): void {
  requireHostedRecord('orch project push')
}
