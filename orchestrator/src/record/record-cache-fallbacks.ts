// concern: record-cache-fallbacks
/** Owns the persisted set of keyset fallbacks scheduled by the record change feed. */
import type { Database } from 'bun:sqlite'
import { readCursor, writeCursor } from './record-cache-cursor.ts'

const FALLBACKS = 'record_change_fallbacks'

export type RecordCacheFallbackFamily = 'doc' | 'subject' | 'lens' | 'workflow' | 'port'

export const recordCacheFallbackKey = (
  family: RecordCacheFallbackFamily,
  spaceId: string,
): string => `${family}:${spaceId}`

export const recordCacheFallbackFamily = (value: string): RecordCacheFallbackFamily =>
  value.slice(0, value.indexOf(':')) as RecordCacheFallbackFamily

export const recordCacheFallbackSpace = (value: string): string =>
  value.slice(value.indexOf(':') + 1)

export function pendingRecordCacheFallbacks(local: Database): Set<string> {
  const value = readCursor(local, FALLBACKS)
  if (!value) return new Set()
  try {
    const parsed = JSON.parse(value)
    return new Set(Array.isArray(parsed) ? parsed.map(String) : [])
  } catch {
    return new Set()
  }
}

export function writePendingRecordCacheFallbacks(
  local: Database,
  values: ReadonlySet<string>,
): void {
  writeCursor(local, FALLBACKS, JSON.stringify([...values].sort()))
}

export function addPendingRecordCacheFallbacks(
  local: Database,
  spaceId: string,
  families: readonly RecordCacheFallbackFamily[],
): void {
  const pending = pendingRecordCacheFallbacks(local)
  for (const family of families) pending.add(recordCacheFallbackKey(family, spaceId))
  writePendingRecordCacheFallbacks(local, pending)
}
