import { recordSpaceMembershipRefusal, recordSpaceOwnerRequiredRemedy } from './record-remedies.ts'
import { type RecordSpaceMembership, recordSpaceMembership } from './record-space-membership.ts'

export type RecordSpaceOwnerFlags = {
  space?: string
  project?: string
  account?: boolean
}

export type RecordSpaceOtherOwner = 'project' | 'account'

export type RecordSpaceOwnerDestination =
  | { kind: 'other-owner'; owner: RecordSpaceOtherOwner }
  | { kind: 'space'; spaceId: string; slug: string }
  | { kind: 'refused'; remedy: string }

export function recordSpaceOwnerDestination(
  verb: string,
  flags: RecordSpaceOwnerFlags,
  accepts: readonly RecordSpaceOtherOwner[],
  memberships: readonly RecordSpaceMembership[],
): RecordSpaceOwnerDestination {
  if (flags.project) return { kind: 'other-owner', owner: 'project' }
  if (flags.account) return { kind: 'other-owner', owner: 'account' }
  if (!flags.space) {
    return { kind: 'refused', remedy: recordSpaceOwnerRequiredRemedy(verb, accepts) }
  }
  const membership = recordSpaceMembership(flags.space, memberships)
  return membership
    ? { kind: 'space', spaceId: membership.spaceId, slug: membership.slug }
    : { kind: 'refused', remedy: recordSpaceMembershipRefusal(flags.space) }
}

/** Resolve an owner at a command edge, refusing a missing flag before loading memberships. */
export async function resolveRecordSpaceOwnerDestination(
  verb: string,
  flags: RecordSpaceOwnerFlags,
  accepts: readonly RecordSpaceOtherOwner[],
  loadMemberships: () => Promise<readonly RecordSpaceMembership[]>,
): Promise<{ spaceId: string; slug: string }> {
  if (!flags.space) {
    const beforeLoad = recordSpaceOwnerDestination(verb, flags, accepts, [])
    if (beforeLoad.kind === 'refused') throw new Error(beforeLoad.remedy)
    if (beforeLoad.kind === 'other-owner') throw new Error(`${verb} owner was not resolved`)
  }
  const destination = recordSpaceOwnerDestination(verb, flags, accepts, await loadMemberships())
  if (destination.kind === 'refused') throw new Error(destination.remedy)
  if (destination.kind === 'other-owner') throw new Error(`${verb} owner was not resolved`)
  return { spaceId: destination.spaceId, slug: destination.slug }
}
