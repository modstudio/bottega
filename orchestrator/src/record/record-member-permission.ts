// concern: record-member-permission
/** Owns owner/admin changes to a space member's read/write permission. */

import { bindTenant } from '../../../shared/record/tenant.ts'
import type { ConfigTenant } from './record-config.ts'
import { ConfigServiceError } from './record-config-error.ts'
import { recordPool } from './record-pool.ts'

export type MemberPermission = 'read' | 'write'

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
    if (String(member.role) === 'owner')
      throw new ConfigServiceError(
        "cannot change an owner's permission because owners always have write permission; change their role first",
        422,
      )
    if (String(member.permission) !== input.permission)
      await tx`UPDATE membership SET permission=${input.permission} WHERE id=${String(member.id)}::uuid`
    return { permission: input.permission }
  })
}
