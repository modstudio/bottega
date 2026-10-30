// concern: record-api-client-machine
/** Builds machine identity record requests without knowing local machine state. */

import type { RecordClientRequest } from './record-api-client-paths.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { RecordSyncRequest, RecordSyncResponse } from './record-sync-contract.ts'

export type RecordMachineClient = {
  whoami(): Promise<RecordIdentity>
  sync?(input: RecordSyncRequest): Promise<RecordSyncResponse>
  renameMachine?(input: {
    machineId: string
    shortName?: string
    displayName?: string
  }): Promise<{ ok: true }>
  retireMachine?(shortName: string): Promise<{ machineId: string }>
}

export function recordMachineClient(
  request: RecordClientRequest,
  identitySchema: (body: unknown) => RecordIdentity,
): RecordMachineClient {
  return {
    whoami: () => request('/v1/whoami', { schema: identitySchema }),
    sync: (input) => request('/v1/sync', { method: 'POST', body: JSON.stringify(input) }),
    renameMachine: (input) =>
      request('/v1/machine/name', { method: 'PUT', body: JSON.stringify(input) }),
    retireMachine: (shortName) =>
      request('/v1/machine/retire', { method: 'POST', body: JSON.stringify({ shortName }) }),
  }
}
