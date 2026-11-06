// concern: outbox-prune
/** Declares the durable receipt marker and retention window for delivered outbox payloads. */

export const RELEASED_OUTBOX_PAYLOAD = ''
export const OUTBOX_PAYLOAD_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000

export function isReleasedOutboxPayload(payload: string): boolean {
  return payload === RELEASED_OUTBOX_PAYLOAD
}

/** SQL predicate whose sole bound argument is RELEASED_OUTBOX_PAYLOAD. */
export function releasedOutboxPayloadSql(column: string): string {
  return `${column}=?`
}

/** SQL predicate whose sole bound argument is RELEASED_OUTBOX_PAYLOAD. */
export function unreleasedOutboxPayloadSql(column: string): string {
  return `${column}<>?`
}
