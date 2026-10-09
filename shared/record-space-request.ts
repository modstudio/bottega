import { type RecordSpaceMembership, recordSpaceMembership } from './record-space-membership.ts'

export type RecordSpaceRequestDecision =
  | { allowed: true; spaceId: string }
  | { allowed: false; requestedSpace: string }

/** Decide the tenant for a route that honors the requested record space. */
export function recordSpaceRequestDecision(
  requestedSpace: string | null,
  activeSpaceId: string,
  memberships: readonly RecordSpaceMembership[],
): RecordSpaceRequestDecision {
  if (requestedSpace === null) return { allowed: true, spaceId: activeSpaceId }
  const membership = recordSpaceMembership(requestedSpace, memberships)
  return membership
    ? { allowed: true, spaceId: membership.spaceId }
    : { allowed: false, requestedSpace }
}
