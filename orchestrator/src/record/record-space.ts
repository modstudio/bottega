// concern: record-space
/** Owns record membership and active-space changes. Must not know CLI presentation. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ModerationHideReason } from '../../../shared/moderation-hide-reason.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { recordSpaceMembership } from '../../../shared/record-space-membership.ts'
import { activeSpaceInvariant } from './active-space-invariant.ts'
import type { MachineNamePair } from './machine-name.ts'
import { claimCurrentMachineNames } from './machine-name-command.ts'
import { type RecordApiClient, recordApiClient } from './record-api-client.ts'
import type { RecordIdentity } from './record-auth.ts'
import { readHostedProjects } from './record-cache-projects.ts'
import type { HiddenRow } from './record-moderation-hide.ts'
import { cachedSignedInRecordUser } from './record-session.ts'

const RECORD_SPACE_ROLES = ['member', 'admin', 'owner'] as const
export type RecordSpaceRole = (typeof RECORD_SPACE_ROLES)[number]

export type RecordMembership = {
  spaceId: string
  name: string
  slug: string
  role: string
  permission: string
}

export type HostedActiveSpace = {
  id: string | null
  slug: string | null
}

export type CreatedRecordSpace = { id: string; slug: string }

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

export async function listRecordSpaceConfigAccess(
  client: Pick<RecordApiClient, 'listConfigAccess'> = recordApiClient(),
) {
  return (await client.listConfigAccess()).items
}

export async function grantRecordSpaceConfigAccess(
  email: string,
  client: Pick<RecordApiClient, 'grantConfigAccess'> = recordApiClient(),
): Promise<void> {
  await client.grantConfigAccess(email)
}

export async function withdrawRecordSpaceConfigAccess(
  email: string,
  client: Pick<RecordApiClient, 'withdrawConfigAccess'> = recordApiClient(),
) {
  return client.withdrawConfigAccess(email)
}

export async function showRecordSpaceOutsideIntake(
  client: Pick<RecordApiClient, 'showOutsideIntake'> = recordApiClient(),
) {
  return (await client.showOutsideIntake()).intake
}

export async function setRecordSpaceOutsideIntake(
  project: string,
  client: Pick<RecordApiClient, 'setOutsideIntake'> = recordApiClient(),
) {
  return (await client.setOutsideIntake(project)).intake
}

export async function pauseRecordSpaceOutsideIntake(
  hours: number,
  client: Pick<RecordApiClient, 'pauseOutsideIntake'> = recordApiClient(),
) {
  return (await client.pauseOutsideIntake(hours)).intake
}

export async function resumeRecordSpaceOutsideIntake(
  client: Pick<RecordApiClient, 'resumeOutsideIntake'> = recordApiClient(),
) {
  return (await client.resumeOutsideIntake()).intake
}

export async function listRecordSpaceOutsideBlocks(
  client: Pick<RecordApiClient, 'listOutsideBlocks'> = recordApiClient(),
) {
  return (await client.listOutsideBlocks()).blocks
}

export async function blockRecordSpaceOutsideAuthor(
  input: { message?: string; note?: string; hours?: number },
  client: Pick<RecordApiClient, 'blockOutsideAuthor'> = recordApiClient(),
) {
  return (await client.blockOutsideAuthor(input)).block
}

export async function unblockRecordSpaceOutsideAuthor(
  userId: string,
  client: Pick<RecordApiClient, 'unblockOutsideAuthor'> = recordApiClient(),
): Promise<void> {
  await client.unblockOutsideAuthor(userId)
}

export async function hideRecordSpaceRow(
  input: { message?: string; note?: string; reason: ModerationHideReason },
  client: Pick<RecordApiClient, 'hideRow'> = recordApiClient(),
): Promise<HiddenRow> {
  return (await client.hideRow(input)).hidden
}

export async function unhideRecordSpaceRow(
  input: { message?: string; note?: string },
  client: Pick<RecordApiClient, 'unhideRow'> = recordApiClient(),
): Promise<void> {
  await client.unhideRow(input)
}

export async function listRecordSpaceHiddenRows(
  client: Pick<RecordApiClient, 'listHidden'> = recordApiClient(),
): Promise<HiddenRow[]> {
  return (await client.listHidden()).hidden
}

export async function recordMemberships(
  client: Pick<RecordApiClient, 'whoami'> = recordApiClient(),
): Promise<{ activeSpaceId: string | null; memberships: RecordMembership[] }> {
  return recordMembershipsFromIdentity(await client.whoami())
}

export async function readSignedInHostedProjectNames(
  client: Pick<RecordApiClient, 'whoami' | 'listProjects'> = recordApiClient(),
): Promise<string[]> {
  if (!cachedSignedInRecordUser()) return []
  const spaces = (await recordMemberships(client)).memberships.map(({ spaceId }) => spaceId)
  return (await readHostedProjects(spaces, client)).map(({ name }) => name)
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
  names?: MachineNamePair,
): Promise<RecordMembership> {
  const listed = await recordMemberships(client)
  const selected = resolveRecordSpace(value, listed.memberships)
  const active = await setAndVerifyActiveRecordSpace(selected.spaceId, client)
  if (names) await claimCurrentMachineNames(names)
  return active
}

/** The only client-side active-space setter; success means whoami proved the write. */
async function setAndVerifyActiveRecordSpace(
  organizationId: string,
  client: Pick<RecordApiClient, 'whoami' | 'setActiveOrganization'> = recordApiClient(),
): Promise<RecordMembership> {
  await client.setActiveOrganization({ organizationId })
  const reread = await recordMemberships(client)
  const decision = activeSpaceInvariant({
    ...reread,
    intendedSpaceId: organizationId,
  })
  if (!decision.holds) throw new Error(decision.message)
  if (!decision.active) throw new Error(`active space none; intended space ${organizationId}`)
  return decision.active
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

function hostedActiveSpace(
  activeSpaceId: string | null,
  memberships: readonly RecordMembership[],
): HostedActiveSpace {
  return {
    id: activeSpaceId,
    slug: memberships.find(({ spaceId }) => spaceId === activeSpaceId)?.slug ?? null,
  }
}

export function recordSpaceCreateReport(
  before: HostedActiveSpace,
  after: HostedActiveSpace,
  created: CreatedRecordSpace,
): string[] {
  const beforeName = before.slug ?? before.id ?? 'none'
  const afterName = after.slug ?? after.id ?? 'none'
  const createdNotActive = [
    `created space ${created.slug} is not active`,
    `switch to it: ${PLATFORM_SLUG} record space switch ${created.slug}`,
  ]
  if (before.id === after.id) {
    const lines = [`active record space unchanged: ${afterName}`]
    if (after.id !== created.id) lines.push(...createdNotActive)
    return lines
  }
  if (after.id === created.id && before.id === null) {
    return [`active record space is now ${afterName}`]
  }
  const lines = [
    `active record space switched from ${beforeName} to ${afterName} for every lane on this machine`,
  ]
  if (before.id !== null) {
    lines.push(`switch back: ${PLATFORM_SLUG} record space switch ${beforeName}`)
  }
  if (after.id !== created.id) lines.push(...createdNotActive)
  return lines
}

export async function createRecordSpace(
  name: string,
  slug: string,
  client: Pick<RecordApiClient, 'whoami' | 'createOrganization'> = recordApiClient(),
): Promise<
  {
    before: HostedActiveSpace
    after: HostedActiveSpace
  } & CreatedRecordSpace
> {
  if (!name.trim()) throw new Error('record space name must be non-empty')
  if (!slug.trim()) throw new Error('record space slug must be non-empty')
  const listed = await recordMemberships(client)
  refuseDuplicateRecordSpaceSlug(slug, listed.memberships)
  const before = hostedActiveSpace(listed.activeSpaceId, listed.memberships)
  const created = await client.createOrganization({ name, slug })
  const afterIdentity = await recordMemberships(client)
  return {
    ...created,
    before,
    after: hostedActiveSpace(afterIdentity.activeSpaceId, afterIdentity.memberships),
  }
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
  client: Pick<RecordApiClient, 'acceptInvitation' | 'whoami'> = recordApiClient(),
  names?: MachineNamePair,
): Promise<string> {
  await client.acceptInvitation(invitationId)
  const reread = await recordMemberships(client)
  const decision = activeSpaceInvariant(reread)
  if (!decision.holds) throw new Error(decision.message)
  if (names) await claimCurrentMachineNames(names)
  return decision.active?.spaceId ?? 'none'
}
