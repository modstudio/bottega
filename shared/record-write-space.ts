import { PLATFORM_SLUG } from './brand.ts'
import {
  type RecordSpaceMembership,
  recordSpaceMembership,
} from './record-space-membership.ts'

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

export type RecordWriteSpaceDecision =
  | { spaceId: string }
  | { refused: 'no-owner' | 'undeclared-project' | 'declared-space-not-member' | 'personal-space-not-provisioned' | 'space-owner-without-value'; remedy: string }

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
  if (owner.kind === 'personal' || (owner.kind === 'session' && !owner.checkoutProject)) {
    return facts.personalSpaceId
      ? { spaceId: facts.personalSpaceId }
      : {
          refused: 'personal-space-not-provisioned',
          remedy: 'personal space is not provisioned',
        }
  }
  const project = owner.kind === 'session' ? owner.checkoutProject! : owner.kind === 'task' ? owner.projectName : owner.name
  const declared = facts.declaredSpaces[project]?.trim()
  if (!declared) {
    return {
      refused: 'undeclared-project',
      remedy: `project ${project} has no declared record space; run \`${PLATFORM_SLUG} project set ${project} --space <slug>\``,
    }
  }
  const membership = recordSpaceMembership(declared, facts.memberships)
  return membership
    ? { spaceId: membership.spaceId }
    : {
        refused: 'declared-space-not-member',
        remedy: `the signed-in user is not a member of record space ${declared}`,
      }
}
