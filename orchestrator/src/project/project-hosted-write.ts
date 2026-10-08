// concern: project-hosted-write
/** Applies project-register write authority at the hosted-record boundary. */

import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import {
  declaredRecordSpace,
  projectDestinationFromIdentity,
  requireProjectRecordDestination,
} from '../record/record-project-destination.ts'
import { applyRecordWriteAuthority, requireHostedRecord } from '../record/record-write-authority.ts'
import type { ProjectSettings, StoredProjectSettings } from './project-settings.ts'

export async function writeProjectToHostedRecord(p: {
  name: string
  previousName?: string
  path: string
  stack?: string | null
  canon?: boolean
  settings?: ProjectSettings | StoredProjectSettings
  retiredAt?: string | null
}): Promise<void> {
  await applyRecordWriteAuthority({
    local: () => undefined,
    hosted: async () => {
      const client = recordApiClient()
      const destinationSpaceId = await requireProjectRecordDestination(p.name, p.settings, client)
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
        { destinationSpaceId },
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

export async function refuseHostedProjectSpaceChange(
  project: { name: string; settings: ProjectSettings | StoredProjectSettings },
  nextSettings: ProjectSettings | StoredProjectSettings,
): Promise<void> {
  if (declaredRecordSpace(project.settings) === declaredRecordSpace(nextSettings)) return
  await applyRecordWriteAuthority({
    local: () => undefined,
    hosted: async () => {
      const client = recordApiClient()
      const identity = await client.whoami()
      const next = projectDestinationFromIdentity(project.name, nextSettings, identity)
      if ('refused' in next) {
        throw new Error(
          `project ${project.name} declares record space ${next.declaredSpace}, but the signed-in user is not a member; join it first with an invitation, then retry`,
        )
      }
      for (const membership of parseRecordSpaceMemberships(identity.memberships)) {
        if (membership.spaceId === next.spaceId) continue
        const rows = await client.listProjects({ destinationSpaceId: membership.spaceId })
        if (rows.some((row) => row.name === project.name)) {
          throw new Error(
            `project ${project.name} already has a hosted row in record space ${membership.spaceId}; run \`orch record space move-project\` before changing settings.space`,
          )
        }
      }
    },
  })
}

export function requireHostedProjectPush(): void {
  requireHostedRecord('orch project push')
}
