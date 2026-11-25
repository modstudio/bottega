// concern: tracker read cursor and adaptive page-size cache

import { TRACKER_DEFAULT_PAGE_SIZE, type TrackerSource } from '../../../shared/trackers.ts'
import { db, type Project, writeTransaction } from '../db.ts'
import {
  TRACKER_SINCE_OVERLAP_MS,
  type TrackerReadMode,
  trackerReadMode,
} from './tracker-read-mode.ts'

export const trackerReadKey = (project: Project) => `collect.tracker.${project}.at`
const trackerSinceKey = (project: Project) => `collect.tracker.${project}.since`
const trackerFullReadKey = (project: Project) => `collect.tracker.${project}.full-at`
const trackerForceFullKey = (project: Project) => `collect.tracker.${project}.force-full`
/** Machine-local cache; losing this value only costs re-probing the tracker's reply limit. */
const trackerPageSizeKey = (project: Project) => `collect.tracker.${project}.page-size`

function trackerSetting(key: string): string | null {
  return (
    db().query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?').get(key)
      ?.value ?? null
  )
}

export function storedTrackerReadMode(
  source: TrackerSource,
  now: string,
): { mode: TrackerReadMode; since: string | null } {
  const since = trackerSetting(trackerSinceKey(source.project))
  return {
    mode: trackerReadMode({
      declared: source.supportsUpdatedSince,
      forceFull: trackerSetting(trackerForceFullKey(source.project)) !== null,
      since,
      lastFullRead: trackerSetting(trackerFullReadKey(source.project)),
      now,
    }),
    since,
  }
}

export function storedTrackerPageSize(project: Project, mode: TrackerReadMode): number {
  const value = Number(trackerSetting(trackerPageSizeKey(project)))
  const remembered =
    Number.isInteger(value) && value >= 1 && value <= TRACKER_DEFAULT_PAGE_SIZE
      ? value
      : TRACKER_DEFAULT_PAGE_SIZE
  return mode === 'full' ? Math.min(TRACKER_DEFAULT_PAGE_SIZE, remembered * 2) : remembered
}

export function recordTrackerPageSize(project: Project, pageSize: number | undefined): void {
  if (pageSize === undefined) return
  writeTransaction((conn) =>
    conn
      .query(`INSERT OR REPLACE INTO setting(key,value) VALUES (?,?)`)
      .run(trackerPageSizeKey(project), String(pageSize)),
  )
}

export function recordTrackerReadState(
  project: Project,
  mode: TrackerReadMode,
  startedAt: string,
  complete: boolean,
): void {
  writeTransaction((conn) => {
    if (!complete) {
      conn
        .query(`INSERT OR REPLACE INTO setting(key,value) VALUES (?,?)`)
        .run(trackerForceFullKey(project), '1')
      return
    }
    const since = new Date(Date.parse(startedAt) - TRACKER_SINCE_OVERLAP_MS).toISOString()
    const write = conn.query(`INSERT OR REPLACE INTO setting(key,value) VALUES (?,?)`)
    write.run(trackerSinceKey(project), since)
    if (mode === 'full') write.run(trackerFullReadKey(project), startedAt)
    conn.query('DELETE FROM setting WHERE key=?').run(trackerForceFullKey(project))
  })
}

export function trackerReadPassComplete(
  fetchedComplete: boolean,
  rejectedChanges: readonly string[],
): boolean {
  return fetchedComplete && rejectedChanges.length === 0
}

export function trackerProjectsReadSince(
  projectNames: readonly Project[],
  cutoffMs: number,
): Set<Project> {
  const fresh = new Set<Project>()
  const read = db().query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
  for (const project of projectNames) {
    const value = read.get(trackerReadKey(project))?.value
    if (value && Date.parse(value) >= cutoffMs) fresh.add(project)
  }
  return fresh
}
