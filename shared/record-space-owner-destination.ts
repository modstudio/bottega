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

/** Resolve an owner at a command edge, refusing a missing flag before loading memberships. */
export async function resolveRecordSpaceOwnerDestination(
  verb: string,
  flags: RecordSpaceOwnerFlags,
  accepts: readonly RecordSpaceOtherOwner[],
  loadMemberships: () => Promise<readonly RecordSpaceMembership[]>,
): Promise<Exclude<RecordSpaceOwnerDestination, { kind: 'refused' }>> {
  const acceptedFlags = {
    ...flags,
    ...(accepts.includes('project') && !Object.hasOwn(flags, 'project')
      ? { project: undefined }
      : {}),
    ...(accepts.includes('account') && !Object.hasOwn(flags, 'account')
      ? { account: false }
      : {}),
  }
  if (!flags.space) {
    const beforeLoad = recordSpaceOwnerDestination(verb, acceptedFlags, [])
    if (beforeLoad.kind === 'refused') throw new Error(beforeLoad.remedy)
    if (beforeLoad.kind === 'other-owner') return beforeLoad
  }
  const destination = recordSpaceOwnerDestination(verb, acceptedFlags, await loadMemberships())
  if (destination.kind === 'refused') throw new Error(destination.remedy)
  return destination
}
