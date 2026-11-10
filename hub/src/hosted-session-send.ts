import {
  type HostedRequestSafety,
  RECORD_SIGN_IN_REMEDY,
  recordUnreachableRefusal,
} from '../../shared/record-remedies.ts'
import { sendWithStoredRecordSessionToken } from '../../shared/record-session.ts'

type HostedSessionRequest = {
  origin: string
  url: string
  method: string
  body?: unknown
  token?: string | null
  recordSpace?: string | null
  safety: HostedRequestSafety
  fetch: (input: string, init: RequestInit) => Promise<Response>
}

/** Send one hub request with either an explicit token or the process record session. */
export async function sendHostedSessionRequest(input: HostedSessionRequest): Promise<Response> {
  const send = async (token: string | null) => {
    if (!token) throw new Error(RECORD_SIGN_IN_REMEDY)
    try {
      return await input.fetch(input.url, {
        method: input.method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(input.recordSpace ? { 'x-record-space': input.recordSpace } : {}),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(recordUnreachableRefusal(input.origin, detail, input.safety))
    }
  }
  return input.token === undefined
    ? await sendWithStoredRecordSessionToken(send)
    : await send(input.token)
}
