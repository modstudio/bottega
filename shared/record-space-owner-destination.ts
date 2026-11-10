import { recordSpaceMembershipRefusal, recordSpaceOwnerRequiredRemedy } from './record-remedies.ts'
import { type RecordSpaceMembership, recordSpaceMembership } from './record-space-membership.ts'

export type RecordSpaceOwnerFlags = {
  space?: string
  project?: string
  account?: boolean
}

export type RecordSpaceOwnerDestination =
  | { kind: 'other-owner'; owner: 'project' | 'account' }
  | { kind: 'space'; spaceId: string; slug: string }
  | { kind: 'refused'; remedy: string }

export function recordSpaceOwnerDestination(
  verb: string,
  flags: RecordSpaceOwnerFlags,
  memberships: readonly RecordSpaceMembership[],
): RecordSpaceOwnerDestination {
  if (flags.project) return { kind: 'other-owner', owner: 'project' }
  if (flags.account) return { kind: 'other-owner', owner: 'account' }
  const alternatives = [
    ...(Object.hasOwn(flags, 'project') ? (['project'] as const) : []),
    ...(Object.hasOwn(flags, 'account') ? (['account'] as const) : []),
  ]
  if (!flags.space) {
    return { kind: 'refused', remedy: recordSpaceOwnerRequiredRemedy(verb, alternatives) }
  }
  const membership = recordSpaceMembership(flags.space, memberships)
  return membership
    ? { kind: 'space', spaceId: membership.spaceId, slug: membership.slug }
    : { kind: 'refused', remedy: recordSpaceMembershipRefusal(flags.space) }
}
