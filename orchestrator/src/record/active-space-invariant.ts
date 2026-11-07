// concern: active-space-invariant
/** Decides whether a hosted identity has a valid active space after a shared-state move. */

import { RECORD_ACTIVE_SPACE_REMEDY } from '../../../shared/record-remedies.ts'

type Membership = { spaceId: string; slug: string }

export type ActiveSpaceInvariant<T extends Membership = Membership> =
  | { holds: true; active: T | null }
  | { holds: false; active: T | null; message: string }

export function activeSpaceInvariant<T extends Membership>(input: {
  activeSpaceId: string | null
  memberships: readonly T[]
  intendedSpaceId?: string
}): ActiveSpaceInvariant<T> {
  if (input.memberships.length === 0 && input.intendedSpaceId === undefined) {
    return { holds: true, active: null }
  }
  const active =
    input.memberships.find((membership) => membership.spaceId === input.activeSpaceId) ?? null
  if (active && (input.intendedSpaceId === undefined || active.spaceId === input.intendedSpaceId)) {
    return { holds: true, active }
  }
  const expected = input.intendedSpaceId ? `; intended space ${input.intendedSpaceId}` : ''
  return {
    holds: false,
    active,
    message: `active space ${input.activeSpaceId ?? 'none'} is not valid${expected}; ${RECORD_ACTIVE_SPACE_REMEDY}`,
  }
}
