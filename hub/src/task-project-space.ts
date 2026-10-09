import {
  type RecordSpaceMembership,
  recordSpaceMembership,
} from '../../shared/record-space-membership.ts'
import { declaredProjectSpace } from './hosted-write-mode.ts'

export type RegisteredTaskSpace = { name: string; settings: { space?: string } }
export type TaskDestinationIdentity = {
  activeSpaceId: string
  memberships: readonly RecordSpaceMembership[]
}
export type TaskProjectDestination =
  | { project: string; destinationSpaceId: string }
  | {
      project: string
      refused: 'unregistered-project' | 'declared-space-not-member'
    }
export type ProjectRowsRefusal<T> = {
  reason: Extract<TaskProjectDestination, { refused: string }>['refused']
  rows: T[]
}

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
  const declared = declaredProjectSpace(project.settings.space)
  if (!declared) return { project: projectName, destinationSpaceId: identity.activeSpaceId }
  const membership = recordSpaceMembership(declared, identity.memberships)
  return membership
    ? { project: projectName, destinationSpaceId: membership.spaceId }
    : { project: projectName, refused: 'declared-space-not-member' }
}

/** Partition project-attributed rows by destination without letting one refusal block another. */
export function partitionProjectRows<T extends { project_name: string | null }>(
  rows: readonly T[],
  registered: readonly RegisteredTaskSpace[],
  identity: TaskDestinationIdentity,
) {
  const destinations = new Map<string, T[]>()
  const refusals = new Map<string, ProjectRowsRefusal<T>>()
  for (const row of rows) {
    if (row.project_name === null) {
      const selected = destinations.get(identity.activeSpaceId) ?? []
      selected.push(row)
      destinations.set(identity.activeSpaceId, selected)
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
