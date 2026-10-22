// concern: throttle health reporting
/** Reads the structured run-event evidence and buckets throttles by observed concurrency. */

export type ThrottleBucket = { concurrency: number; throttles: number }

export function bucketThrottles(events: Array<{ concurrency: number }>): ThrottleBucket[] {
  const counts = new Map<number, number>()
  for (const event of events)
    counts.set(event.concurrency, (counts.get(event.concurrency) ?? 0) + 1)
  return [...counts]
    .map(([concurrency, throttles]) => ({ concurrency, throttles }))
    .sort((a, b) => a.concurrency - b.concurrency)
}
