// concern: throttle health reporting
/** Reads the structured run-event evidence and buckets throttles by observed concurrency. */

import type { Database } from 'bun:sqlite'
import { readEventLog, runEventsPath } from '../events.ts'

export type ThrottleBucket = { concurrency: number; throttles: number }

export function bucketThrottles(events: Array<{ concurrency: number }>): ThrottleBucket[] {
  const counts = new Map<number, number>()
  for (const event of events)
    counts.set(event.concurrency, (counts.get(event.concurrency) ?? 0) + 1)
  return [...counts]
    .map(([concurrency, throttles]) => ({ concurrency, throttles }))
    .sort((a, b) => a.concurrency - b.concurrency)
}

export function throttleBuckets(input: {
  database: Database
  from: string
  runsDir?: string
}): ThrottleBucket[] {
  const runs = input.database
    .query("SELECT record_id FROM run WHERE agent='codex' AND datetime(started_at) >= datetime(?)")
    .all(input.from) as { record_id: string }[]
  const events = runs.flatMap((run) =>
    readEventLog(runEventsPath(run.record_id, input.runsDir)).flatMap((event) =>
      event.type === 'throttled' ? [{ concurrency: event.concurrency }] : [],
    ),
  )
  return bucketThrottles(events)
}
