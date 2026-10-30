// concern: record-api-client-session
/** Builds hosted session identity and evidence-sync requests. */

import type { RecordClientRequest } from './record-api-client-paths.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { RecordSyncRequest, RecordSyncResponse } from './record-sync-contract.ts'

export type RecordSessionClient = {
  whoami(): Promise<RecordIdentity>
  sync?(input: RecordSyncRequest): Promise<RecordSyncResponse>
}

export function recordSessionClient(
  request: RecordClientRequest,
  identitySchema: (body: unknown) => RecordIdentity,
): RecordSessionClient {
  return {
    whoami: () => request('/v1/whoami', { schema: identitySchema }),
    sync: (input) => request('/v1/sync', { method: 'POST', body: JSON.stringify(input) }),
  }
}
