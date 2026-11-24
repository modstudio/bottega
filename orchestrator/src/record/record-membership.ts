/** Keep an active space only while it remains a current membership. */
export function activeMembershipSpace(
  activeSpaceId: string | null,
  membershipSpaceIds: readonly string[],
): string | null {
  return activeSpaceId && membershipSpaceIds.includes(activeSpaceId) ? activeSpaceId : null
}
