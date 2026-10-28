// concern: codex-quota
/** Parses quota readings from the Codex rollout text written by one turn. */

export type CodexQuotaReadings = {
  quotaUsedPercentStart: number | null
  quotaUsedPercentEnd: number | null
  quotaWindowMinutes: number | null
  quotaResetsAt: number | null
}

export const EMPTY_CODEX_QUOTA_READINGS: CodexQuotaReadings = {
  quotaUsedPercentStart: null,
  quotaUsedPercentEnd: null,
  quotaWindowMinutes: null,
  quotaResetsAt: null,
}

type PrimaryRateLimit = { usedPercent: number; windowMinutes: number; resetsAt: number }

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
  return { usedPercent, windowMinutes, resetsAt }
}

/** Invalid and unrelated JSONL lines are ignored; no valid readings yields all nulls. */
export function parseCodexQuotaReadings(text: string): CodexQuotaReadings {
  const readings: PrimaryRateLimit[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      const payload =
        event.payload && typeof event.payload === 'object'
          ? (event.payload as Record<string, unknown>)
          : event
      if (payload.type !== 'token_count') continue
      const rateLimits = payload.rate_limits
      if (!rateLimits || typeof rateLimits !== 'object') continue
      const primary = primaryRateLimit((rateLimits as Record<string, unknown>).primary)
      if (primary) readings.push(primary)
    } catch {
      // A partial rollout line must not make the run fail.
    }
  }
  const first = readings[0]
  const last = readings.at(-1)
  if (!first || !last) return EMPTY_CODEX_QUOTA_READINGS
  return {
    quotaUsedPercentStart: first.usedPercent,
    quotaUsedPercentEnd: last.usedPercent,
    quotaWindowMinutes: last.windowMinutes,
    quotaResetsAt: last.resetsAt,
  }
}
