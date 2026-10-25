const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * IDs are minted by the application before a database connection exists; no id column has a
 * default. The trigger-written hub_change and hub_change_head rows are the exception: because a
 * trigger cannot call application code, public.record_uuid_v7() mints their IDs in SQL. That mint
 * sorts calls from distinct microseconds by time but does not order calls within one microsecond.
 */
let lastRecordId = ''

export function newRecordId(): string {
  let candidate = Bun.randomUUIDv7()
  while (candidate <= lastRecordId) candidate = Bun.randomUUIDv7()
  lastRecordId = candidate
  return candidate
}

/** Stable hosted identity for a local record copied into a space. */
export function replicatedRecordId(spaceId: string, kind: string, sourceId: string): string {
  const hex = new Bun.CryptoHasher('sha256')
    .update(`${spaceId}\0${kind}\0${sourceId}`)
    .digest('hex')
    .slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`
}

export function hasRecordIdShape(value: string): boolean {
  return RECORD_ID.test(value)
}
