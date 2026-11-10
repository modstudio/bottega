// concern: project-fill-space
/** Reads the hosted register facts needed to plan the project-space backfill. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import { readHostedProjects } from '../record/record-cache-projects.ts'
import {
  currentRecordWriteDecision,
  requireHostedRecord,
  throwIfRecordRefused,
} from '../record/record-write-authority.ts'
import { declaredProjectSpaceRemedy } from './declared-project-space.ts'
import { decideProjectSpaceFill, type FillSpaceDecision } from './project-fill-space-decision.ts'
import { projects } from './projects.ts'

export type ProjectSpaceFillRow = {
  project: string
  declaredSpace: string | null
  hostedSpaces: string[]
  decision: FillSpaceDecision
  remedy: string
}

export async function planProjectSpaceFill(): Promise<ProjectSpaceFillRow[]> {
  const authority = currentRecordWriteDecision()
  throwIfRecordRefused(authority)
  if (authority.verdict === 'local-authoritative') {
    requireHostedRecord(`${PLATFORM_SLUG} project fill-space`)
  }
  const client = recordApiClient()
  const identity = await client.whoami()
  const memberships = parseRecordSpaceMemberships(identity.memberships)
  const hosted = (
    await readHostedProjects(
      memberships.map(({ spaceId }) => spaceId),
      client,
    )
  ).filter((row) => memberships.some(({ spaceId }) => row.spaceId === spaceId))

  return projects().map((project) => {
    const hostedSpaceIds = hosted
      .filter((row) => row.name === project.name)
      .map((row) => row.spaceId)
    const decision = decideProjectSpaceFill({
      declared: project.settings.space,
      memberships,
      hostedSpaceIds,
    })
    const hostedSpaces = [...new Set(hostedSpaceIds)]
      .map((spaceId) => memberships.find((membership) => membership.spaceId === spaceId)!.slug)
      .sort()
    return {
      project: project.name,
      declaredSpace: project.settings.space ?? null,
      hostedSpaces,
      decision,
      remedy: declaredProjectSpaceRemedy(project.name),
    }
  })
}
