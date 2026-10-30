// concern: record-sync-decision
/** Pure authorization decisions for hosted evidence sync. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  parseRecordSpaceMemberships,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import { recordSpaceAccessDecision } from '../../../shared/record-space-request.ts'
import type { RecordIdentity } from './record-auth.ts'
import { recordSpaceMembershipRefusal } from './record-project-destination.ts'
import type { RecordPrincipal } from './record-sync-contract.ts'

export type RecordSyncAuthorizationDecision =
  | { status: 'allowed'; principal: RecordPrincipal }
  | { status: 'deferred'; reason: string; spaceId: string }
  | { status: 'refused'; reason: string }

export function recordSyncAuthorizationDecision(
  identity: RecordIdentity,
  spaceHint: string | null,
): RecordSyncAuthorizationDecision {
  const memberships = parseRecordSpaceMemberships(identity.memberships)
  const destination = spaceHint ?? identity.activeSpaceId
  if (!destination) return { status: 'refused', reason: 'record session has no active space' }
  const membership = recordSpaceMembership(destination, memberships)
  if (!membership) {
    return { status: 'refused', reason: recordSpaceMembershipRefusal(destination) }
  }
  const access = recordSpaceAccessDecision('write', membership.spaceId, memberships)
  if (!access.allowed) {
    return {
      status: 'deferred',
      reason: `${access.error}; ${access.remedy}`,
      spaceId: membership.spaceId,
    }
  }
  return {
    status: 'allowed',
    principal: { userId: identity.user.id, spaceId: membership.spaceId },
  }
}

export type RecordSyncMachineOwnershipDecision =
  | { status: 'allowed' }
  | { status: 'refused'; reason: string }

export function recordSyncMachineOwnershipDecision(
  machineId: string,
  existingOwnerId: string | null,
  sessionUserId: string,
): RecordSyncMachineOwnershipDecision {
  if (existingOwnerId === null || existingOwnerId === sessionUserId) return { status: 'allowed' }
  return {
    status: 'refused',
    reason: `machine ${machineId} is registered to another user; sign in as the user that registered this machine, then retry \`${PLATFORM_SLUG} record sync\``,
  }
}

/**
 * Row policies hide another space's rows, so a reference that is absent and one
 * that belongs to someone else look the same to the service.
 */
export function recordSyncReferenceRefusal(reference: { kind: string; id: string }): string {
  return `${reference.kind} ${reference.id} is absent from this space or belongs to another machine or user; sync the record it refers to from this machine first, then retry \`${PLATFORM_SLUG} record sync\``
}

export class RecordSyncRequestRefusal extends Error {}

export class MachineNameRefusal extends RecordSyncRequestRefusal {}
