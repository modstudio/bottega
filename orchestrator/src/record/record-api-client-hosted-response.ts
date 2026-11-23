// concern: record API hosted-response policy
/** Adapts shared hosted JSON diagnostics to record-client error classification. */

import { hostedJsonFailureMessage, type jsonBody } from '../../../shared/http-json.ts'
import type { HostedRequestSafety } from '../../../shared/record-remedies.ts'

type HostedBody = Awaited<ReturnType<typeof jsonBody>>

export const hostedErrorBody = (
  body: unknown,
  result: HostedBody,
  url: string,
  status: number,
): unknown =>
  body ?? {
    error: hostedJsonFailureMessage(
      result.ok ? { ok: false, url, status, contentType: 'missing' } : result,
    ),
  }

export const hostedRequestSafety = (method?: string): HostedRequestSafety => {
  const normalized = method?.toUpperCase() ?? 'GET'
  return normalized === 'GET' || normalized === 'HEAD' ? 'probe' : 'non-idempotent'
}
