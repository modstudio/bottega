import {
  type HostedRequestSafety,
  hostedRequestSafetyStatement,
} from '../../shared/record-remedies.ts'

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

