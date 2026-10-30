export type HostedRequestSafety = 'probe' | 'idempotent' | 'non-idempotent'

type HostedRefusal = {
  status?: number
  statusText?: string
  body?: unknown
  cause?: unknown
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
    return 'nothing was written'
  if (refusal.safety === 'idempotent') return 'safe to retry'
  return 'the write may have been applied; check before retrying'
}

export function hostedRefusalError(refusal: HostedRefusal): Error {
  const body = objectBody(refusal.body)
  const status = refusal.status === undefined ? 'network error' : String(refusal.status)
  const cause = refusal.cause instanceof Error ? refusal.cause.message : String(refusal.cause ?? '')
  const detail =
    typeof body?.error === 'string' && body.error.trim()
      ? body.error
      : refusal.statusText?.trim() || cause || status
  const serverRemedy =
    typeof body?.remedy === 'string' && body.remedy.trim() ? body.remedy.trim() : null
  const retry = retryStatement(refusal)
  const serverStatesWriteOutcome = [
    'nothing was written',
    'safe to retry',
    'check before retrying',
  ].some((statement) => serverRemedy?.toLowerCase().includes(statement))
  const remedies = [
    serverRemedy,
    serverStatesWriteOutcome || serverRemedy?.toLowerCase().includes(retry) ? null : retry,
  ]
    .filter((value): value is string => value !== null)
    .map((value) => value.replace(/[.\s]+$/, ''))
  return new Error(`hosted hub refused the request (${status}): ${detail}. ${remedies.join('. ')}`)
}
