export type RecordSpaceMembership = { spaceId: string; slug: string }

/** Match the register's declared space, which may be either a stable id or a human slug. */
export function recordSpaceMembership(
  declared: string,
  memberships: readonly RecordSpaceMembership[],
): RecordSpaceMembership | undefined {
  return memberships.find(
    (membership) => membership.spaceId === declared || membership.slug === declared,
  )
}
