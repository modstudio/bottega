// concern: record-sync-principal
/** Binds a hosted-record transaction to the principal selected by sync. */

import type { SQL } from 'bun'
import type { RecordPrincipal } from './record-sync-types.ts'

export async function bindPrincipal(tx: SQL, principal: RecordPrincipal): Promise<void> {
  await tx`SELECT set_config('app.user_id', ${principal.userId}, true)`
  await tx`SELECT set_config('app.space_id', ${principal.spaceId}, true)`
}
