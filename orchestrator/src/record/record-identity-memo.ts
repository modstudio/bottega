// concern: record-api-client
/** Routes hosted record identity through the shared process read memo. */

import { hostedApiFetch } from '../../../shared/bounded-fetch.ts'
import { memoizedConfigRead } from '../../../shared/config-read-memo.ts'
import { RECORD_WHOAMI_ROUTE, type RecordClientRequest } from './record-api-client-paths.ts'
import type { RecordIdentity } from './record-auth.ts'
import { storedRecordToken } from './record-session.ts'

export function recordIdentityMemoRequest(
  request: RecordClientRequest,
  baseUrl: () => string,
): RecordClientRequest {
  return async <T>(path: string, init = {}): Promise<T> => {
    if (path === RECORD_WHOAMI_ROUTE) {
      const token = storedRecordToken()
      if (token)
        return memoizedConfigRead(
          hostedApiFetch,
          baseUrl(),
          token,
          path,
          () => request<RecordIdentity>(path, init),
        ) as Promise<T>
    }
    return request<T>(path, init)
  }
}
