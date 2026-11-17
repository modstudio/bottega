import { type RecordSpaceMembership, recordSpaceMembership } from './record-space-membership.ts'

export type RecordSpaceRequestDecision =
  | { allowed: true; spaceId: string | null }
  | { allowed: false; requestedSpace: string }

export type RecordSpaceAccessDecision =
  | { allowed: true }
  | { allowed: false; error: string; remedy: string }

/** Classify an HTTP request for hosted-space authorization. */
export function recordRequestNature(method: string): 'read' | 'write' {
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write'
}

/** Decide whether a hosted read is keyed by a UUID that is unique across record spaces. */
export function recordReadIsUuidKeyed(route: string, readKind?: string): boolean {
  if (route === '/v1/questions')
    return ['by-id', 'for-run', 'for-runs', 'for-cursor', 'open-for-cursors'].includes(
      readKind ?? '',
    )
  if (route === '/v1/task-flow') return readKind === 'flow'
  return /^\/v1\/task-flow\/(stages|texts|obligations)\/[^/]+$/.test(route)
}

/** Decide whether the caller's membership permits the requested operation. */
export function recordSpaceAccessDecision(
  nature: 'read' | 'write',
  spaceId: string,
  memberships: readonly RecordSpaceMembership[],
): RecordSpaceAccessDecision {
  if (nature === 'read') return { allowed: true }
  const membership = recordSpaceMembership(spaceId, memberships)
  if (membership?.permission === 'write') return { allowed: true }
  return {
    allowed: false,
    error: `record space ${spaceId} membership is read-only`,
    remedy: 'A space owner or admin can change the membership permission.',
  }
}

/** Decide the tenant for a route that honors the requested record space. */
export function recordSpaceRequestDecision(
  requestedSpace: string | null,
  activeSpaceId: string | null,
  memberships: readonly RecordSpaceMembership[],
): RecordSpaceRequestDecision {
  if (requestedSpace === null) return { allowed: true, spaceId: activeSpaceId }
  const membership = recordSpaceMembership(requestedSpace, memberships)
  return membership
    ? { allowed: true, spaceId: membership.spaceId }
    : { allowed: false, requestedSpace }
}
