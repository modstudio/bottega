// concern: record-space
/** Owns record membership and active-space changes. Must not know CLI presentation. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type StoredMachineNames, writeMachineNames } from '../../../shared/machine-config.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { recordSpaceMembership } from '../../../shared/record-space-membership.ts'
import { machineId } from './machine-identity.ts'
import { type RecordApiClient, recordApiClient } from './record-api-client.ts'
import type { RecordIdentity } from './record-auth.ts'
import { syncRecord } from './record-sync.ts'

const RECORD_SPACE_ROLES = ['member', 'admin', 'owner'] as const
export type RecordSpaceRole = (typeof RECORD_SPACE_ROLES)[number]

export type RecordMembership = {
  spaceId: string
  name: string
  slug: string
  role: string
  permission: string
}

export function recordSpaceRole(value: string): RecordSpaceRole {
  if (value === 'member' || value === 'admin' || value === 'owner') return value
  throw new Error('record invitation role must be member, admin, or owner')
}

function resolveRecordSpace(
  value: string,
  memberships: readonly RecordMembership[],
): RecordMembership {
  const match = recordSpaceMembership(value, memberships)
  if (match) return match
  const slugs =
    memberships
      .map((membership) => membership.slug)
      .sort()
      .join(', ') || '(none)'
  throw new Error(
    `record space ${value} is not one of the user's memberships; available slugs: ${slugs}`,
  )
}

export function recordMembershipsFromIdentity(identity: RecordIdentity): {
  activeSpaceId: string | null
  memberships: RecordMembership[]
} {
  return {
    activeSpaceId: identity.activeSpaceId,
    memberships: identity.memberships
      .map((row) => ({
        spaceId: String(row.space_id),
        name: String(row.name),
        slug: String(row.slug),
        role: String(row.role),
        permission: String(row.permission),
      }))
      .sort((left, right) => left.slug.localeCompare(right.slug)),
  }
}

export async function recordMemberships(
  client: Pick<RecordApiClient, 'whoami'> = recordApiClient(),
): Promise<{ activeSpaceId: string | null; memberships: RecordMembership[] }> {
  return recordMembershipsFromIdentity(await client.whoami())
}

export async function requireRecordSpaceMembership(
  value: string,
  client: Pick<RecordApiClient, 'whoami'> = recordApiClient(),
): Promise<RecordMembership> {
  const listed = await recordMemberships(client)
  try {
    return resolveRecordSpace(value, listed.memberships)
  } catch {
    throw new Error(
      `record space ${value} is not one of the signed-in user's memberships; join it first with an invitation, then retry`,
    )
  }
}

export async function switchRecordSpace(
  value: string,
  client: Pick<RecordApiClient, 'whoami' | 'setActiveOrganization'> = recordApiClient(),
  names?: StoredMachineNames,
): Promise<RecordMembership> {
  const listed = await recordMemberships(client)
  const selected = resolveRecordSpace(value, listed.memberships)
  await client.setActiveOrganization({ organizationId: selected.spaceId })
  if (names) await claimCurrentMachineNames(names)
  return selected
}

export async function claimCurrentMachineNames(names: StoredMachineNames): Promise<void> {
  const result = await syncRecord({ identity: { id: machineId(), ...names } })
  if (result.machineNameRefusal) throw new Error(result.machineNameRefusal)
  writeMachineNames(names)
}

export function refuseDuplicateRecordSpaceSlug(
  slug: string,
  memberships: readonly RecordMembership[],
): void {
  if (hasRecordIdShape(slug.trim())) {
    throw new Error(
      `record space slug ${slug} is shaped like a record id and would make space selection ambiguous; choose a non-UUID slug`,
    )
  }
  const duplicate = memberships.find((membership) => membership.slug === slug)
  if (duplicate) throw new Error(`record space slug ${slug} already exists: ${duplicate.spaceId}`)
}

export async function createRecordSpace(
  name: string,
  slug: string,
  client: Pick<RecordApiClient, 'whoami' | 'createOrganization'> = recordApiClient(),
): Promise<{ id: string; slug: string }> {
  if (!name.trim()) throw new Error('record space name must be non-empty')
  if (!slug.trim()) throw new Error('record space slug must be non-empty')
  const listed = await recordMemberships(client)
  refuseDuplicateRecordSpaceSlug(slug, listed.memberships)
  return client.createOrganization({ name, slug })
}

export async function inviteToActiveRecordSpace(
  email: string,
  role: RecordSpaceRole,
  client: Pick<RecordApiClient, 'whoami' | 'inviteMember'> = recordApiClient(),
): Promise<string> {
  const identity = await client.whoami()
  if (!identity.activeSpaceId) {
    throw new Error(
      `record session has no active space; run \`${PLATFORM_SLUG} record space switch <slug>\``,
    )
  }
  const invitation = await client.inviteMember({
    email,
    role,
    organizationId: identity.activeSpaceId,
  })
  return invitation.id
}

export async function pendingRecordInvitations(
  client: Pick<RecordApiClient, 'listInvitations'> = recordApiClient(),
) {
  return client.listInvitations()
}

export async function acceptRecordInvitation(
  invitationId: string,
  client: Pick<RecordApiClient, 'acceptInvitation'> = recordApiClient(),
  names?: StoredMachineNames,
): Promise<string> {
  const accepted = await client.acceptInvitation(invitationId)
  if (names) await claimCurrentMachineNames(names)
  return accepted.invitation.organizationId
}
