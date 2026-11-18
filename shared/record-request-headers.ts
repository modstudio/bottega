// concern: record-request-headers
/** Owns outbound authentication, destination, and caller headers for record and hosted requests. */

import { CALLER_HEADER_NAME, recordCallerToken } from './record-caller.ts'

type RecordRequestHeaderInput = {
  bearerToken?: string
  destinationSpaceId?: string | null
  headers?: HeadersInit
}

export const RECORD_SPACE_HEADER_NAME = 'x-record-space'

/** Build the common headers for one outbound record or hosted request. */
export function recordRequestHeaders(input: RecordRequestHeaderInput = {}): Headers {
  const headers = new Headers(input.headers)
  if (input.bearerToken !== undefined) headers.set('authorization', `Bearer ${input.bearerToken}`)
  if (input.destinationSpaceId) headers.set(RECORD_SPACE_HEADER_NAME, input.destinationSpaceId)
  headers.set(CALLER_HEADER_NAME, recordCallerToken())
  return headers
}
