// concern: record-cache-registration
/** Rewinds already-pulled record streams when a project becomes locally owned. */
import type { Database } from 'bun:sqlite'
import { deleteCursor, readCursor } from './record-cache-cursor.ts'
import { addPendingRecordCacheFallbacks } from './record-cache-fallbacks.ts'

const PULL_SPACES = 'record_change_pull_spaces'

function pulledSpaces(local: Database): string[] {
  const value = readCursor(local, PULL_SPACES)
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export function rewindRecordCacheForProjectRegistration(local: Database, spaceId: string): boolean {
  if (!pulledSpaces(local).includes(spaceId)) return false
  deleteCursor(local, `record_subjects_cursor:${spaceId}`)
  deleteCursor(local, `record_docs_cursor:${spaceId}`)
  addPendingRecordCacheFallbacks(local, spaceId, ['subject', 'doc'])
  return true
}
