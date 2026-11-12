import type { RecordSpaceMembership } from '../../shared/record-space-membership.ts'
import {
  type ProjectWriteSpaceRefusal,
  projectWriteSpace,
} from '../../shared/record-write-space.ts'
import { declaredProjectSpace } from './hosted-write-mode.ts'
import { personalRecordSpace } from './personal-record-space.ts'

export type RegisteredTaskSpace = {
  name: string
  settings: { space?: string; keyPrefixes?: string[] }
}
export type TaskDestinationIdentity = {
  activeSpaceId: string
  memberships: readonly RecordSpaceMembership[]
}
export type TaskProjectDestination =
  | { project: string; destinationSpaceId: string }
  | {
      project: string
      refused: 'unregistered-project' | ProjectWriteSpaceRefusal
    }
export type ProjectRowsRefusal<T> = {
  reason: Extract<TaskProjectDestination, { refused: string }>['refused']
  rows: T[]
}
type PersonalRecordSpaceResolver = () => Promise<string>

/** Spaces the task pull reads: the active space plus every registered destination. */
export function taskPullSpaces(
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
): string[] {
  const spaces = new Set([identity.activeSpaceId])
  for (const project of registered) {
    const destination = taskProjectDestination(project.name, registered, identity)
    if ('destinationSpaceId' in destination) spaces.add(destination.destinationSpaceId)
  }
  return [...spaces]
}

/** Resolve a project's registered destination against the signed-in user's memberships. */
export function taskProjectDestination(
  projectName: string,
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
): TaskProjectDestination {
  const project = registered.find((candidate) => candidate.name === projectName)
  if (!project) return { project: projectName, refused: 'unregistered-project' }
  const decision = projectWriteSpace(projectName, {
    declaredSpaces: { [projectName]: declaredProjectSpace(project.settings.space) },
    memberships: identity.memberships,
  })
  return 'spaceId' in decision
    ? { project: projectName, destinationSpaceId: decision.spaceId }
    : { project: projectName, refused: decision.refused }
}

/** Partition project-attributed rows by destination without letting one refusal block another. */
export async function partitionProjectRows<T extends { project_name: string | null }>(
  rows: readonly T[],
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
  resolvePersonalSpace: PersonalRecordSpaceResolver = personalRecordSpace,
) {
  const destinations = new Map<string, T[]>()
  const refusals = new Map<string, ProjectRowsRefusal<T>>()
  let personalSpace: string | undefined
  for (const row of rows) {
    if (row.project_name === null) {
      personalSpace ??= await resolvePersonalSpace()
      const selected = destinations.get(personalSpace) ?? []
      selected.push(row)
      destinations.set(personalSpace, selected)
      continue
    }
    const decision = taskProjectDestination(row.project_name, registered, identity)
    if ('refused' in decision) {
      const refusal = refusals.get(row.project_name) ?? { reason: decision.refused, rows: [] }
      refusal.rows.push(row)
      refusals.set(row.project_name, refusal)
      continue
    }
    const selected = destinations.get(decision.destinationSpaceId) ?? []
    selected.push(row)
    destinations.set(decision.destinationSpaceId, selected)
  }
  return { destinations, refusals }
}
