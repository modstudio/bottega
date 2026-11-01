// concern: record-cache-cursor
/** Stores record paging cursors in the local schema_meta. */
import type { Database } from 'bun:sqlite'
import { parseStoredRecordCursor, type RecordCursor } from './record-cursor.ts'

export function readCursor(local: Database, key: string): string | undefined {
  return local
    .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
    .get(key)?.value
}

export function writeCursor(local: Database, key: string, value: string): void {
  local
    .query(
      'INSERT INTO schema_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key, value)
}

export function readRecordCursor(
  local: Database,
  key: string,
  legacyTimestamp = false,
): RecordCursor | undefined {
  const value = readCursor(local, key)
  if (value === undefined) return undefined
  const parsed = parseStoredRecordCursor(value, legacyTimestamp)
  if ('cursor' in parsed) {
    if (parsed.migrated) writeRecordCursor(local, key, parsed.cursor)
    return parsed.cursor
  }
  throw new Error(`invalid record cache cursor for ${key}`)
}

export function writeRecordCursor(local: Database, key: string, cursor: RecordCursor): void {
  writeCursor(local, key, JSON.stringify(cursor))
}
