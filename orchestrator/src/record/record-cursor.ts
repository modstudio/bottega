// concern: record-cursor
/** Owns the opaque paging cursor shared by record API route families. */
import { z } from 'zod'

export type RecordCursor = { at: string; id: string }
export const recordCursorAt = Symbol('recordCursorAt')

export type RecordCursorRow = {
  id: string
  updatedAt: string
  [recordCursorAt]?: string
}

const RecordCursorSchema = z.object({
  at: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
})

export const encodeRecordCursor = (cursor: RecordCursor): string => btoa(JSON.stringify(cursor))

export const decodeRecordCursor = (value: string): RecordCursor =>
  RecordCursorSchema.parse(JSON.parse(atob(value)))

export const recordCursorOf = (row: RecordCursorRow): RecordCursor => ({
  at: row[recordCursorAt] ?? row.updatedAt,
  id: row.id,
})

export type StoredRecordCursorParse =
  | { cursor: RecordCursor; migrated: boolean }
  | { invalid: true }

const FIRST_RECORD_ID = '00000000-0000-0000-0000-000000000000'

export function parseStoredRecordCursor(
  value: string,
  acceptLegacyTimestamp: boolean,
): StoredRecordCursorParse {
  try {
    const parsed = RecordCursorSchema.safeParse(JSON.parse(value))
    if (parsed.success) return { cursor: parsed.data, migrated: false }
  } catch {
    // A legacy cursor is a raw timestamp rather than JSON.
  }
  if (acceptLegacyTimestamp) {
    const migrated = RecordCursorSchema.safeParse({ at: value, id: FIRST_RECORD_ID })
    if (migrated.success) return { cursor: migrated.data, migrated: true }
  }
  return { invalid: true }
}

export function pageRecordItems<T>(
  items: T[],
  limit: number,
  cursorOf: (item: T) => RecordCursor,
  returnEndCursor = false,
): { items: T[]; nextCursor: string | null; endCursor?: string | null } {
  const hasMore = items.length > limit
  if (hasMore) items.pop()
  const last = items.at(-1)
  const endCursor = last ? encodeRecordCursor(cursorOf(last)) : null
  return {
    items,
    nextCursor: hasMore ? endCursor : null,
    ...(returnEndCursor ? { endCursor } : {}),
  }
}
