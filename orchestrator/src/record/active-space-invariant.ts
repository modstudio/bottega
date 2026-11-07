// concern: active-space-invariant
/** Decides whether a hosted identity has a valid active space after a shared-state move. */

import { RECORD_ACTIVE_SPACE_REMEDY } from '../../../shared/record-remedies.ts'

type Membership = { spaceId: string; slug: string }

export type ActiveSpaceInvariant =
  | { holds: true; active: Membership | null }
  | { holds: false; active: Membership | null; message: string }

export function activeSpaceInvariant(input: {
  activeSpaceId: string | null
  memberships: readonly Membership[]
  intendedSpaceId?: string
}): ActiveSpaceInvariant {
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
