// concern: record-cursor
/** Owns the opaque paging cursor shared by record API route families. */
import { z } from 'zod'

export type RecordCursor = { at: string; id: string }

export const RecordCursorSchema = z.object({
  at: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
})

export const encodeRecordCursor = (cursor: RecordCursor): string => btoa(JSON.stringify(cursor))

export const decodeRecordCursor = (value: string): RecordCursor =>
  RecordCursorSchema.parse(JSON.parse(atob(value)))

export function pageRecordItems<T>(
  items: T[],
  limit: number,
  cursorOf: (item: T) => RecordCursor,
): { items: T[]; nextCursor: string | null } {
  const hasMore = items.length > limit
  if (hasMore) items.pop()
  const last = items.at(-1)
  return {
    items,
    nextCursor: hasMore && last ? encodeRecordCursor(cursorOf(last)) : null,
  }
}
