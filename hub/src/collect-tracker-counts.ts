import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { successfulTrackerRead, type TrackerResult } from './ingest/tracker-result.ts'

export type TrackerCounts = {
  read: number
  skippedFresh: number
  leftToWatcher: number
  unreportedParentProjects: { project: string; count: number }[]
  ambiguousParentProjects: { project: string; count: number; keys: string[] }[]
}

export function trackerCounts(
  results: TrackerResult[],
  skippedFresh: number,
  leftToWatcher: number,
): TrackerCounts {
  const successful = results.filter(successfulTrackerRead)
  return {
    read: successful.length,
    skippedFresh,
    leftToWatcher,
    unreportedParentProjects: successful.map((result) => ({
      project: result.project,
      count: result.unreportedParents ?? 0,
    })),
    ambiguousParentProjects: successful.map((result) => ({
      project: result.project,
      count: result.ambiguousParents ?? 0,
      keys: result.ambiguousParentKeys ?? [],
    })),
  }
}

export function formatTrackerCounts(counts: TrackerCounts): string[] {
  const parts = [`${counts.read} trackers read`]
  if (counts.leftToWatcher)
    parts.push(
      `${counts.leftToWatcher} left to the watcher; force with ${PLATFORM_SLUG} record pull --only tasks`,
    )
  if (counts.skippedFresh) parts.push(`${counts.skippedFresh} skipped fresh`)
  for (const guard of counts.unreportedParentProjects)
    parts.push(`${guard.project} ${guard.count} parents unreported`)
  for (const guard of counts.ambiguousParentProjects) {
    const keys = guard.keys.length ? ` (${guard.keys.join(', ')})` : ''
    parts.push(`${guard.project} ${guard.count} parents ambiguous${keys}`)
  }
  return parts
}
