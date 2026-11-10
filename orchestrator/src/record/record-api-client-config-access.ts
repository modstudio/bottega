// concern: record-api-client-config-access
/** Owns hosted config-access membership requests. */

import type { RecordClientRequest } from './record-api-client-paths.ts'

export type RecordConfigAccessClient = {
  listConfigAccess(): Promise<{
    items: Array<{ email: string; role: string; permission: string; configAccess: boolean }>
  }>
  grantConfigAccess(email: string, destinationSpaceId: string): Promise<{ granted: true }>
  withdrawConfigAccess(email: string, destinationSpaceId: string): Promise<{
    revokedMachineKeyIds: string[]
    readableSecretKeys: string[]
  }>
}

export function recordConfigAccessClient(request: RecordClientRequest): RecordConfigAccessClient {
  return {
    listConfigAccess: () => request('/v1/config-access'),
    grantConfigAccess: (email, destinationSpaceId) =>
      request('/v1/config-access/grant', {
        method: 'POST',
        destinationSpaceId,
        body: JSON.stringify({ email }),
      }),
    withdrawConfigAccess: (email, destinationSpaceId) =>
      request('/v1/config-access/withdraw', {
        method: 'POST',
        destinationSpaceId,
        body: JSON.stringify({ email }),
      }),
  }
}
