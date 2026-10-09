import { hasRecordIdShape } from './record-id.ts'

export type RecordSpaceMembership = { spaceId: string; slug: string }

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
  const value = declared.trim()
  const id = memberships.find(
    (membership) => membership.spaceId.toLowerCase() === value.toLowerCase(),
  )
  if (id || hasRecordIdShape(value)) return id
  return memberships.find((membership) => membership.slug === value)
}
