// concern: record-api-client
/** Routes hosted record identity through the shared process read memo. */

import type { Database } from 'bun:sqlite'
import { memoizedConfigRead } from '../../../shared/config-read-memo.ts'
import { RECORD_WHOAMI_ROUTE } from '../../../shared/record-routes.ts'
import type { RecordApiAuthentication, RecordClientRequest } from './record-api-client-paths.ts'
import { recordIdentityResponse } from './record-api-client-session.ts'
import type { RecordIdentity } from './record-auth.ts'
import { storedRecordToken } from './record-session.ts'

type TransportedRecordClientRequest = <T>(
  path: string,
  init?: RequestInit & {
    schema?: (body: unknown) => T
    acceptedError?: { status: number; schema: (body: unknown) => T }
    destinationSpaceId?: string
  },
  authentication?: RecordApiAuthentication,
  transport?: typeof fetch,
  preflight?: () => void,
  origin?: string,
  database?: Database,
) => Promise<T>

function recordIdentityMemoRequest(
  request: RecordClientRequest,
  baseUrl: () => string,
  transport: typeof fetch,
  database?: Database,
): RecordClientRequest {
  return async <T>(path: string, init = {}): Promise<T> => {
    if (path === RECORD_WHOAMI_ROUTE) {
      const token = storedRecordToken(database)
      if (token)
        return ((init as { schema?: (body: unknown) => T }).schema ?? recordIdentityResponse)(
          await memoizedConfigRead(
            transport,
            baseUrl(),
            token,
            path,
            (init as { destinationSpaceId?: string }).destinationSpaceId,
            undefined,
            () => request<RecordIdentity>(path, init),
          ),
        ) as T
    }
    return request<T>(path, init)
  }
}

export function selectRecordApiTransport(
  request: RecordClientRequest,
  realRequest: TransportedRecordClientRequest,
  baseUrl: () => string,
  transport: typeof fetch,
  database?: Database,
): RecordClientRequest {
  if (request !== realRequest) return request
  const transportedRequest: RecordClientRequest = (path, init) =>
    realRequest(path, init, undefined, transport, undefined, undefined, database)
  return recordIdentityMemoRequest(transportedRequest, baseUrl, transport, database)
}
