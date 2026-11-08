export const TRACKER_FULL_READ_MS = 24 * 60 * 60_000
export const TRACKER_SINCE_OVERLAP_MS = 5 * 60_000

export type TrackerReadMode = 'full' | 'incremental'

/** Decide the tracker read shape without consulting storage, a clock, or a server. */
export function trackerReadMode(input: {
  declared: boolean
  forceFull: boolean
  since: string | null
  lastFullRead: string | null
  now: string
}): TrackerReadMode {
  if (input.forceFull || !input.declared || !input.since || !input.lastFullRead) return 'full'
  const now = Date.parse(input.now)
  const lastFullRead = Date.parse(input.lastFullRead)
  if (!Number.isFinite(now) || !Number.isFinite(lastFullRead)) return 'full'
  return now - lastFullRead >= TRACKER_FULL_READ_MS ? 'full' : 'incremental'
}
