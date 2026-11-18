// concern: long-lived run record-request rate
/** Decides when one long-lived executor exceeded its hosted request-rate bound. */

export const LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX = 6
export const LONG_LIVED_RECORD_REQUEST_ALLOWANCE = 60
export const LONG_LIVED_RECORD_REQUEST_WINDOW_MS = 60_000

export function exceedsLongLivedRecordRequestRate(input: {
  count: number
  elapsedMs: number
  windowIndex: number
}): boolean {
  if (input.elapsedMs <= 0) return false
  if (input.windowIndex === 1) return input.count > LONG_LIVED_RECORD_REQUEST_ALLOWANCE
  const proratedBound =
    LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX *
    (Math.min(input.elapsedMs, LONG_LIVED_RECORD_REQUEST_WINDOW_MS) /
      LONG_LIVED_RECORD_REQUEST_WINDOW_MS)
  return input.count > proratedBound
}
