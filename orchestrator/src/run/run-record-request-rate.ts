// concern: long-lived run record-request rate
/** Decides when one long-lived executor exceeded its hosted request-rate bound. */

export const LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX = 6
export const LONG_LIVED_RECORD_REQUEST_ALLOWANCE = 60

export function exceedsLongLivedRecordRequestRate(input: {
  count: number
  elapsedMs: number
}): boolean {
  if (input.count <= LONG_LIVED_RECORD_REQUEST_ALLOWANCE || input.elapsedMs <= 0) return false
  return (
    (input.count - LONG_LIVED_RECORD_REQUEST_ALLOWANCE) / (input.elapsedMs / 60_000) >
    LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX
  )
}
