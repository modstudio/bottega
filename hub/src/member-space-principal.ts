import type { TenantPrincipal } from '../../shared/record/tenant.ts'

export type AuthenticatedSpaceIdentity = TenantPrincipal & { spaceIds: readonly string[] }

export class MemberSpaceRefusal extends Error {}

/** Bind a tenant principal to an explicitly requested authenticated membership. */
export function principalForMemberSpace(
  identity: AuthenticatedSpaceIdentity,
  requestedSpaceId: string | undefined,
): TenantPrincipal {
  if (!requestedSpaceId || !identity.spaceIds.includes(requestedSpaceId))
    throw new MemberSpaceRefusal(
      `target space ${requestedSpaceId ?? '(missing)'} is not one of the authenticated user's memberships`,
    )
  return { userId: identity.userId, spaceId: requestedSpaceId, spaceIds: identity.spaceIds }
}
