/**
 * Convert a timestamp read from the record into a Date without losing milliseconds.
 * The Postgres driver returns timestamp columns as Date, and String(date) prints whole
 * seconds, so a Date converts by its epoch milliseconds. A string or number takes the
 * native constructor; anything else is an invalid Date, as the constructor would give.
 */
export function recordDate(value: unknown): Date {
  if (value instanceof Date) {
    return new Date(value.getTime())
  }
  if (typeof value === 'string') {
    return new Date(value)
  }
  if (typeof value === 'number') {
    return new Date(value)
  }
  return new Date(Number.NaN)
}

/** A nullable record timestamp as a Date; null and undefined pass through as null. */
export function nullableRecordDate(value: unknown): Date | null {
  return value == null ? null : recordDate(value)
}

/** A record timestamp as ISO text with its milliseconds. */
export function recordIso(value: unknown): string {
  return recordDate(value).toISOString()
}

/**
 * Whether two record timestamps have the same canonical instant. The canonical
 * form keeps JavaScript Date precision: milliseconds; finer fractions are truncated.
 */
export function sameRecordInstant(left: unknown, right: unknown): boolean {
  if (left == null || right == null) return left == null && right == null
  return recordIso(left) === recordIso(right)
}

/** Return the later record timestamp in canonical form; the left wins a tie. */
export function later(left: unknown, right: unknown): string {
  const leftIso = recordIso(left)
  const rightIso = recordIso(right)
  return leftIso >= rightIso ? leftIso : rightIso
}

/** A nullable record timestamp as ISO text; null and undefined pass through as null. */
export function nullableRecordIso(value: unknown): string | null {
  return value == null ? null : recordIso(value)
}
