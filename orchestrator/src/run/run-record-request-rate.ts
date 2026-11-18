// concern: long-lived run record-request rate
/** Decides when one long-lived executor exceeded its hosted request-rate bound. */

export const LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX = 6
export const LONG_LIVED_RECORD_REQUEST_ALLOWANCE = 60
export const LONG_LIVED_RECORD_REQUEST_WINDOW_MS = 60_000

export function exceedsLongLivedRecordRequestRate(input: {
  count: number
  windowIndex: number
}): boolean {
  if (input.windowIndex === 1) return input.count > LONG_LIVED_RECORD_REQUEST_ALLOWANCE
  return input.count > LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX
}
