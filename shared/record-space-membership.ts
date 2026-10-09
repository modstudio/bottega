export type RecordSpaceMembership = { spaceId: string; slug: string }

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function hasRecordIdShape(value: string): boolean {
  return RECORD_ID.test(value)
}

export function parseRecordSpaceMemberships(value: unknown): RecordSpaceMembership[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return []
    const membership = row as Record<string, unknown>
    return typeof membership.space_id === 'string' && typeof membership.slug === 'string'
      ? [{ spaceId: membership.space_id, slug: membership.slug }]
      : []
  })
}

/** Match the register's declared space, which may be either a stable id or a human slug. */
export function recordSpaceMembership<T extends RecordSpaceMembership>(
  declared: string,
  memberships: readonly T[],
): T | undefined {
  return (
    memberships.find((membership) => membership.spaceId === declared) ??
    memberships.find((membership) => membership.slug === declared)
  )
}
