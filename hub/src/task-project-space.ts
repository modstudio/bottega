import { recordSpaceMembership } from '../../shared/record-space-membership.ts'
import type { HostedTaskIdentity } from './task-client.ts'

export type RegisteredTaskSpace = { name: string; settings: { space?: string } }
export type TaskProjectSpaceDisposition =
  | { belongsToActiveSpace: true; targetSpaceId: string }
  | {
      belongsToActiveSpace: false
      targetSpaceId: string | null
      reason: 'unmapped' | 'different-space'
    }

/** Apply the project-space rule shared by task push and foreign-task cleanup. */
export function taskProjectSpaceDisposition(
  projectName: string,
  registered: readonly RegisteredTaskSpace[],
  identity: HostedTaskIdentity,
): TaskProjectSpaceDisposition {
  const project = registered.find((candidate) => candidate.name === projectName)
  if (!project) return { belongsToActiveSpace: false, targetSpaceId: null, reason: 'unmapped' }
  const declared = project.settings.space
  if (!declared) return { belongsToActiveSpace: true, targetSpaceId: identity.activeSpaceId }
  const membership = recordSpaceMembership(declared, identity.memberships)
  if (!membership) return { belongsToActiveSpace: false, targetSpaceId: null, reason: 'unmapped' }
  return membership.spaceId === identity.activeSpaceId
    ? { belongsToActiveSpace: true, targetSpaceId: membership.spaceId }
    : {
        belongsToActiveSpace: false,
        targetSpaceId: membership.spaceId,
        reason: 'different-space',
      }
}
