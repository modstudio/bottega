// concern: long-lived run record-request rate
/** Decides when one long-lived executor exceeded its hosted request-rate bound. */

export const LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX = 6

export function exceedsLongLivedRecordRequestRate(input: {
  count: number
  elapsedMs: number
}): boolean {
  if (input.count <= 0 || input.elapsedMs <= 0) return false
  return input.count / (input.elapsedMs / 60_000) > LONG_LIVED_RECORD_REQUESTS_PER_MINUTE_MAX
}
