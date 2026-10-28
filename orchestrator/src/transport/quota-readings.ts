// concern: quota-readings
/** Harness-neutral quota readings carried from transports into run persistence. */

export type QuotaReadings = {
  quotaUsedPercentStart: number | null
  quotaUsedPercentEnd: number | null
  quotaWindowMinutes: number | null
  quotaResetsAt: number | null
}

export const EMPTY_QUOTA_READINGS: QuotaReadings = {
  quotaUsedPercentStart: null,
  quotaUsedPercentEnd: null,
  quotaWindowMinutes: null,
  quotaResetsAt: null,
}
