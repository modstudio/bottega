import { recordSpaceMembership } from '../../shared/record-space-membership.ts'
import { declaredProjectSpace } from './hosted-write-mode.ts'
import type { HostedTaskIdentity } from './task-client.ts'

export type RegisteredTaskSpace = { name: string; settings: { space?: string } }
export type TaskProjectDestination =
  | { project: string; destinationSpaceId: string }
  | {
      project: string
      refused: 'unregistered-project' | 'declared-space-not-member'
    }

/** Resolve a project's registered destination against the signed-in user's memberships. */
export function taskProjectDestination(
  projectName: string,
  registered: readonly RegisteredTaskSpace[],
  identity: HostedTaskIdentity,
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
