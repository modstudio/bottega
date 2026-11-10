import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  type HostedRequestSafety,
  hostedRequestSafetyStatement,
  recordUnreachableRefusal,
} from '../../shared/record-remedies.ts'
import { sendWithStoredRecordSessionToken } from '../../shared/record-session.ts'

export type { HostedRequestSafety } from '../../shared/record-remedies.ts'

type HostedRefusal = {
  status?: number
  statusText?: string
  body?: unknown
  safety: HostedRequestSafety
}

function objectBody(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function retryStatement(refusal: HostedRefusal): string {
  if (
    refusal.safety === 'probe' ||
    (refusal.status !== undefined && refusal.status >= 400 && refusal.status < 500)
  )
    return hostedRequestSafetyStatement('probe')
  return hostedRequestSafetyStatement(refusal.safety)
}

export function hostedRefusalError(refusal: HostedRefusal): Error {
  const body = objectBody(refusal.body)
  const status = refusal.status === undefined ? 'network error' : String(refusal.status)
  const detail =
    typeof body?.error === 'string' && body.error.trim()
      ? body.error
      : refusal.statusText?.trim() || status
  const serverRemedy =
    typeof body?.remedy === 'string' && body.remedy.trim() ? body.remedy.trim() : null
  const retry = retryStatement(refusal)
  const serverStatesWriteOutcome = (['probe', 'idempotent', 'non-idempotent'] as const).some(
    (safety) => serverRemedy?.toLowerCase().includes(hostedRequestSafetyStatement(safety)),
  )
  const remedies = [
    serverRemedy,
    serverStatesWriteOutcome || serverRemedy?.toLowerCase().includes(retry) ? null : retry,
  ]
    .filter((value): value is string => value !== null)
    .map((value) => value.replace(/[.\s]+$/, ''))
  return new Error(`hosted hub refused the request (${status}): ${detail}. ${remedies.join('. ')}`)
}

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
    if (!token)
      throw new Error(
        `record session is absent. Run \`${PLATFORM_SLUG} record sign-in\`, then \`${PLATFORM_SLUG} record doctor\`.`,
      )
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
