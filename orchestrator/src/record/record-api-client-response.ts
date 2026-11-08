// concern: record-api-client-response
/** Owns generic record API response shape and message parsing. */

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
