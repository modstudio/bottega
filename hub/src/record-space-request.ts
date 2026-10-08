import {
  type RecordSpaceMembership,
  recordSpaceMembership,
} from '../../shared/record-space-membership.ts'

export type TaskRequestSpaceDecision =
  | { allowed: true; spaceId: string }
  | { allowed: false; requestedSpace: string }

/** Decide the tenant for a route that honors the requested record space. */
export function taskRequestSpaceDecision(
  requestedSpace: string | null,
  activeSpaceId: string,
  memberships: readonly RecordSpaceMembership[],
): TaskRequestSpaceDecision {
  if (requestedSpace === null) return { allowed: true, spaceId: activeSpaceId }
  const membership = recordSpaceMembership(requestedSpace, memberships)
  return membership
    ? { allowed: true, spaceId: membership.spaceId }
    : { allowed: false, requestedSpace }
}
