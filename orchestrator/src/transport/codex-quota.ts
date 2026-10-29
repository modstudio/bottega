// concern: codex-quota
/** Parses quota readings from the Codex rollout text written by one turn. */
import { EMPTY_QUOTA_READINGS, type QuotaReadings, usableQuotaReset } from './quota-readings.ts'

type PrimaryRateLimit = { usedPercent: number; windowMinutes: number; resetsAt: number }

/** Harnesses whose transport persists quota readings on completed runs. */
export function harnessCollectsQuotaReadings(harness: string | undefined): boolean {
  return harness === 'codex'
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function primaryRateLimit(value: unknown): PrimaryRateLimit | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const usedPercent = finiteNumber(row.used_percent)
  const windowMinutes = finiteNumber(row.window_minutes)
  const resetsAt = finiteNumber(row.resets_at)
  if (usedPercent === null || windowMinutes === null || resetsAt === null) return null
  if (usedPercent < 0 || usedPercent > 100 || windowMinutes <= 0 || !usableQuotaReset(resetsAt))
    return null
  return { usedPercent, windowMinutes, resetsAt }
}

function quotaReadingFromLine(line: string): PrimaryRateLimit | null {
  if (!line.trim()) return null
  try {
    const event = JSON.parse(line) as Record<string, unknown>
    const payload =
      event.payload && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>)
        : event
    if (payload.type !== 'token_count') return null
    const rateLimits = payload.rate_limits
    if (!rateLimits || typeof rateLimits !== 'object') return null
    return primaryRateLimit((rateLimits as Record<string, unknown>).primary)
  } catch {
    return null
  }
}

/** Invalid and unrelated JSONL lines are ignored; no valid readings yields all nulls. */
export function parseCodexQuotaReadings(text: string): QuotaReadings {
  const readings: PrimaryRateLimit[] = []
  for (const line of text.split('\n')) {
    const reading = quotaReadingFromLine(line)
    if (reading) readings.push(reading)
  }
  const last = readings.at(-1)
  const first = last && readings.find((reading) => reading.resetsAt === last.resetsAt)
  if (!first || !last) return EMPTY_QUOTA_READINGS
  return {
    quotaUsedPercentStart: first.usedPercent,
    quotaUsedPercentEnd: last.usedPercent,
    quotaWindowMinutes: last.windowMinutes,
    quotaResetsAt: last.resetsAt,
  }
}
