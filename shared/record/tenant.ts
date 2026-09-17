// concern: postgres-tenant-binding
/** Binds database-enforced read and write tenancy for one transaction. */
import type { SQL } from 'bun'

export type TenantPrincipal = {
  userId: string
  spaceId: string
  spaceIds?: readonly string[]
}

export async function bindTenant(tx: SQL, principal: TenantPrincipal): Promise<void> {
  await tx`SELECT set_config('app.user_id', ${principal.userId}, true)`
  await tx`SELECT set_config('app.space_id', ${principal.spaceId}, true)`
  await tx`SELECT set_config('app.space_ids', ${[...(principal.spaceIds ?? [principal.spaceId])].join(',')}, true)`
}
