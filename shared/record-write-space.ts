import { recordSpaceMembershipRefusal, undeclaredProjectSpaceRefusal } from './record-remedies.ts'
import { type RecordSpaceMembership, recordSpaceMembership } from './record-space-membership.ts'

export type RecordWriteOwner =
  | { kind: 'project'; name: string }
  | { kind: 'task'; projectName: string }
  | { kind: 'session'; checkoutProject: string | null }
  | { kind: 'personal' }
  | { kind: 'space'; value: string | null }

export type RecordWriteSpaceFacts = {
  declaredSpaces: Readonly<Record<string, string | null | undefined>>
  personalSpaceId: string | null
  memberships: readonly RecordSpaceMembership[]
}

export type ProjectWriteSpaceRefusal = 'undeclared-project' | 'declared-space-not-member'

export type RecordWriteSpaceRefusal =
  | ProjectWriteSpaceRefusal
  | 'no-owner'
  | 'personal-space-not-provisioned'
  | 'space-owner-without-value'

export type RecordWriteSpaceDecision =
  | { spaceId: string }
  | { refused: RecordWriteSpaceRefusal; remedy: string }

export type ProjectWriteSpaceDecision =
  | { spaceId: string }
  | { refused: ProjectWriteSpaceRefusal; remedy: string }

export function recordWriteSpace(
  owner: RecordWriteOwner | null,
  facts: RecordWriteSpaceFacts,
): RecordWriteSpaceDecision {
  if (!owner) return { refused: 'no-owner', remedy: 'name the write owner, then retry' }
  if (owner.kind === 'space') {
    return owner.value
      ? { spaceId: owner.value }
      : { refused: 'space-owner-without-value', remedy: 'retry with --space <slug>' }
  }
  if (owner.kind === 'project') return projectWriteSpace(owner.name, facts)
  if (owner.kind === 'task') return projectWriteSpace(owner.projectName, facts)
  if (owner.kind === 'session' && owner.checkoutProject) {
    return projectWriteSpace(owner.checkoutProject, facts)
  }
  return facts.personalSpaceId
    ? { spaceId: facts.personalSpaceId }
    : { refused: 'personal-space-not-provisioned', remedy: 'personal space is not provisioned' }
}

/** The project arm of the decision, typed so project adapters see only project refusals. */
export function projectWriteSpace(
  project: string,
  facts: Pick<RecordWriteSpaceFacts, 'declaredSpaces' | 'memberships'>,
): ProjectWriteSpaceDecision {
  const declared = facts.declaredSpaces[project]?.trim()
  if (!declared) {
    return { refused: 'undeclared-project', remedy: undeclaredProjectSpaceRefusal(project) }
  }
  const membership = recordSpaceMembership(declared, facts.memberships)
  return membership
    ? { spaceId: membership.spaceId }
    : { refused: 'declared-space-not-member', remedy: recordSpaceMembershipRefusal(declared) }
}
