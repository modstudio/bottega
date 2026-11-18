import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { successfulTrackerRead, type TrackerResult } from './ingest/trackers.ts'

export type TrackerCounts = {
  read: number
  skippedFresh: number
  leftToWatcher: number
  unreportedParents: { project: string; count: number }[]
}

export function trackerCounts(
  results: TrackerResult[],
  skippedFresh: number,
  leftToWatcher: number,
): TrackerCounts {
  return {
    read: results.filter(successfulTrackerRead).length,
    skippedFresh,
    leftToWatcher,
    unreportedParents: results
      .filter(successfulTrackerRead)
      .map((result) => ({ project: result.project, count: result.unreportedParents ?? 0 })),
  }
}

export function formatTrackerCounts(counts: TrackerCounts): string[] {
  const parts = [`${counts.read} trackers read`]
  if (counts.leftToWatcher)
    parts.push(
      `${counts.leftToWatcher} left to the watcher; force with ${PLATFORM_SLUG} record pull --only tasks`,
    )
  if (counts.skippedFresh) parts.push(`${counts.skippedFresh} skipped fresh`)
  for (const guard of counts.unreportedParents)
    parts.push(`${guard.project} ${guard.count} parents unreported`)
  return parts
}
