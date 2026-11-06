// concern: record-member-permission
/** Owns a space member's read/write permission and the rule that an owner is always write. */

import type { SQL } from 'bun'
import { bindTenant } from '../../../shared/record/tenant.ts'
import type { ConfigTenant } from './record-config.ts'
import { ConfigServiceError } from './record-config-error.ts'
import { recordPool } from './record-pool.ts'

export const MEMBER_PERMISSIONS = ['read', 'write'] as const
export type MemberPermission = (typeof MEMBER_PERMISSIONS)[number]

/** Better Auth stores a member's roles as a comma list; any list holding owner is an owner. */
export function isSpaceOwner(role: string): boolean {
  return role.split(',').some((part) => part.trim() === 'owner')
}

/** An owner membership is always write, so a read member promoted to owner gains write. */
export async function keepOwnerWrite(
  client: SQL,
  member: { id: string; role: string },
): Promise<void> {
  if (!isSpaceOwner(member.role)) return
  await client`UPDATE membership SET permission='write' WHERE id=${member.id}::uuid AND permission<>'write'`
}

export async function setSpaceMemberPermission(
  input: ConfigTenant & { email: string; permission: MemberPermission },
): Promise<{ permission: MemberPermission }> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    const members = await tx`
      SELECT m.id, m.role, m.permission
      FROM membership m JOIN "user" u ON u.id=m.user_id
      WHERE m.space_id=${input.spaceId}::uuid
        AND lower(u.email)=lower(${input.email})
        AND record_membership_admin(m.space_id)
      FOR UPDATE OF m
    `
    const member = members[0]
    if (!member)
      throw new ConfigServiceError(
        'member permission change requires an owner or admin and an email belonging to this space; ask a space owner or admin to retry with a listed member',
        422,
      )
    if (isSpaceOwner(String(member.role)))
      throw new ConfigServiceError(
        "cannot change an owner's permission because owners always have write permission; change their role first",
        422,
      )
    if (String(member.permission) !== input.permission)
      await tx`UPDATE membership SET permission=${input.permission} WHERE id=${String(member.id)}::uuid`
    return { permission: input.permission }
  })
}
