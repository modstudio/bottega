// concern: record-api-client
/** Routes hosted record identity through the shared process read memo. */

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
) => Promise<T>

function recordIdentityMemoRequest(
  request: RecordClientRequest,
  baseUrl: () => string,
  transport: typeof fetch,
): RecordClientRequest {
  return async <T>(path: string, init = {}): Promise<T> => {
    if (path === RECORD_WHOAMI_ROUTE) {
      const token = storedRecordToken()
      if (token)
        return recordIdentityResponse(
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
): RecordClientRequest {
  if (request !== realRequest) return request
  const transportedRequest: RecordClientRequest = (path, init) =>
    realRequest(path, init, undefined, transport)
  return recordIdentityMemoRequest(transportedRequest, baseUrl, transport)
}
