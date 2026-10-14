const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** IDs are minted before a database connection exists; no id column has a default. */
let lastRecordId = ''

export function newRecordId(): string {
  let candidate = Bun.randomUUIDv7()
  while (candidate <= lastRecordId) candidate = Bun.randomUUIDv7()
  lastRecordId = candidate
  return candidate
}

export function hasRecordIdShape(value: string): boolean {
  return RECORD_ID.test(value)
}
