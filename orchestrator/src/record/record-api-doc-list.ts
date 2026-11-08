// concern: record-api-doc-list
/** Pages readable hosted docs while separating walk progress from safe commit progress. */
import { encodeRecordCursor, recordCursorOf } from './record-cursor.ts'
import type { RecordDocListEntry } from './record-docs.ts'

export function recordDocListPage(entries: RecordDocListEntry[], limit: number) {
  const hasMore = entries.length > limit
  const page = entries.slice(0, limit)
  const items = page.flatMap((entry) => ('readable' in entry ? [entry.readable] : []))
  const unreadable = page.flatMap((entry) => ('unreadable' in entry ? [entry.unreadable] : []))
  const firstUnreadable = page.findIndex((entry) => 'unreadable' in entry)
  const cursorItems = page
    .slice(0, firstUnreadable < 0 ? page.length : firstUnreadable)
    .flatMap((entry) => ('readable' in entry ? [entry.readable] : []))
  const last = cursorItems.at(-1)
  const endCursor = last ? encodeRecordCursor(recordCursorOf(last)) : null
  const lastEntry = page.at(-1)
  const nextCursor = lastEntry
    ? encodeRecordCursor(
        'readable' in lastEntry ? recordCursorOf(lastEntry.readable) : lastEntry.cursor,
      )
    : null
  return {
    items,
    unreadable,
    nextCursor: hasMore ? nextCursor : null,
    endCursor,
  }
}
