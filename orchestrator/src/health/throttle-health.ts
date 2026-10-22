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
    .query(
      `SELECT r.record_id FROM run r LEFT JOIN agent a ON a.name=r.agent
        WHERE COALESCE(a.harness,r.agent)='codex'`,
    )
    .all() as { record_id: string }[]
  const events = runs.flatMap((run) =>
    readEventLog(runEventsPath(run.record_id, input.runsDir)).flatMap((event) =>
      event.type === 'throttled' && event.ts >= input.from
        ? [{ concurrency: event.concurrency }]
        : [],
    ),
  )
  return bucketThrottles(events)
}
