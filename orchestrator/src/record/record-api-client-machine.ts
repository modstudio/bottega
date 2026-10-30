// concern: record-api-client-machine
/** Builds machine rename and retirement requests without knowing local machine state. */

import type { RecordClientRequest } from './record-api-client-paths.ts'

export type RecordMachineClient = {
  renameMachine?(input: {
    machineId: string
    shortName?: string
    displayName?: string
  }): Promise<{ ok: true }>
  retireMachine?(shortName: string): Promise<{ machineId: string }>
}

export function recordMachineClient(request: RecordClientRequest): RecordMachineClient {
  return {
    renameMachine: (input) =>
      request('/v1/machine/name', { method: 'PUT', body: JSON.stringify(input) }),
    retireMachine: (shortName) =>
      request('/v1/machine/retire', { method: 'POST', body: JSON.stringify({ shortName }) }),
  }
}
