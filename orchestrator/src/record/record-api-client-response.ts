// concern: record-api-client-response
/** Owns generic record API response shape and message parsing. */

export class RecordApiRequestError extends Error {
  readonly kind: 'unreachable' | 'server' | 'refused' | 'conflict'
  readonly status: number | null
  readonly code: string | null
  readonly existingAccount: boolean
  readonly currentRevision: string | null
  readonly reason: string | null
  readonly condition: string

  constructor(
    message: string,
    kind: 'unreachable' | 'server' | 'refused' | 'conflict',
    status: number | null = null,
    code: string | null = null,
    existingAccount = false,
    currentRevision: string | null = null,
    reason: string | null = null,
    condition = message,
  ) {
    super(message)
    this.kind = kind
    this.status = status
    this.code = code
    this.existingAccount = existingAccount
    this.currentRevision = currentRevision
    this.reason = reason
    this.condition = condition
  }
}

export const responseRecord = (body: unknown): Record<string, unknown> =>
  body && typeof body === 'object' ? (body as Record<string, unknown>) : {}

export function responseMessage(body: unknown, fallback: string): string {
  const record = responseRecord(body)
  const nested = responseRecord(record.error)
  return (
    (typeof record.error === 'string' && record.error) ||
    (typeof record.message === 'string' && record.message) ||
    (typeof nested.message === 'string' && nested.message) ||
    fallback
  )
}

export function responseCode(body: unknown): string | null {
  const record = responseRecord(body)
  const nested = responseRecord(record.error)
  return (
    (typeof record.code === 'string' && record.code) ||
    (typeof nested.code === 'string' && nested.code) ||
    null
  )
}
