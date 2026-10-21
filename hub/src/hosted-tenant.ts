// concern: hosted-tenant
/** Runs hosted record work in a transaction with request-local tenant settings. */

import type { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from '../../shared/record/tenant.ts'

export type TaskIdentity = TenantPrincipal

export async function withHostedTenant<T>(
  client: SQL,
  identity: TaskIdentity,
  work: (tx: SQL) => Promise<T>,
) {
  return client.begin(async (tx) => {
    await bindTenant(tx, identity)
    return work(tx)
  })
}
