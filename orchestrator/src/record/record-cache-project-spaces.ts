// concern: record-cache-project-spaces
/**
 * Tracks the project-to-space map as of the last completed pull and schedules the keyset
 * rereads required by ownership transitions. This snapshot stays separate from the
 * record_project_spaces route cache because registration updates that cache before any pull.
 */
import type { Database } from 'bun:sqlite'
import { writeTransaction } from '../database/db.ts'
import {
  deleteCursor,
  docsCursorKey,
  readCursor,
  subjectsCursorKey,
  writeCursor,
} from './record-cache-cursor.ts'
import { addPendingRecordCacheFallbacks } from './record-cache-fallbacks.ts'

const PROJECT_SPACES = 'record_cache_project_spaces'

type StoredProjectSpaces = [project: string, spaceId: string | null][]

function encodeProjectSpaces(projectSpaces: ReadonlyMap<string, string | null>): string {
  return JSON.stringify([...projectSpaces].sort(([left], [right]) => left.localeCompare(right)))
}

function readProjectSpaces(local: Database): Map<string, string | null> | null {
  const stored = readCursor(local, PROJECT_SPACES)
  if (stored === undefined) return null
  return new Map(JSON.parse(stored) as StoredProjectSpaces)
}

export function rewindChangedRecordCacheProjectSpaces(
  local: Database,
  projectSpaces: ReadonlyMap<string, string | null>,
  previouslyPulledSpaces: ReadonlySet<string>,
): void {
  const previous = readProjectSpaces(local) ?? new Map<string, string | null>()
  const rewind = new Set<string>()
  for (const [project, spaceId] of projectSpaces) {
    if (
      spaceId !== null &&
      previous.get(project) !== spaceId &&
      previouslyPulledSpaces.has(spaceId)
    )
      rewind.add(spaceId)
  }
  if (!rewind.size) return
  writeTransaction(() => {
    for (const spaceId of rewind) {
      deleteCursor(local, subjectsCursorKey(spaceId))
      deleteCursor(local, docsCursorKey(spaceId))
      addPendingRecordCacheFallbacks(local, spaceId, ['subject', 'doc'])
    }
  }, local)
}

export function rememberRecordCacheProjectSpaces(
  local: Database,
  projectSpaces: ReadonlyMap<string, string | null>,
): void {
  writeCursor(local, PROJECT_SPACES, encodeProjectSpaces(projectSpaces))
}
