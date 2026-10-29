// concern: quota-readings
/** Harness-neutral quota readings carried from transports into run persistence. */

export type QuotaReadings = {
  quotaUsedPercentStart: number | null
  quotaUsedPercentEnd: number | null
  quotaWindowMinutes: number | null
  quotaResetsAt: number | null
}

const MIN_SANE_RESET_SECONDS = 946_684_800 // 2000-01-01
const MAX_SANE_RESET_SECONDS = 4_102_444_800 // 2100-01-01

/** Quota resets outside this range are not usable by parsing or routing. */
export function usableQuotaReset(resetsAt: number): boolean {
  return (
    Number.isFinite(resetsAt) &&
    resetsAt >= MIN_SANE_RESET_SECONDS &&
    resetsAt <= MAX_SANE_RESET_SECONDS
  )
}

export const EMPTY_QUOTA_READINGS: QuotaReadings = {
  quotaUsedPercentStart: null,
  quotaUsedPercentEnd: null,
  quotaWindowMinutes: null,
  quotaResetsAt: null,
}
