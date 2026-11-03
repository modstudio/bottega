// concern: record-api-client-config-access
/** Owns hosted config-access membership requests. */

import type { RecordClientRequest } from './record-api-client-paths.ts'

export type RecordConfigAccessClient = {
  listConfigAccess(): Promise<{
    items: Array<{ email: string; role: string; permission: string; configAccess: boolean }>
  }>
  grantConfigAccess(email: string): Promise<{ granted: true }>
}

export function recordConfigAccessClient(request: RecordClientRequest): RecordConfigAccessClient {
  return {
    listConfigAccess: () => request('/v1/config-access'),
    grantConfigAccess: (email) =>
      request('/v1/config-access/grant', {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),
  }
}
