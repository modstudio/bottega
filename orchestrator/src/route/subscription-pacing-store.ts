// concern: route subscription pacing store
/** Loads one bounded set of quota facts for a routing pass. */
import type { Database } from 'bun:sqlite'
import { QUOTA_MIN_WINDOW_PERCENT } from '../run/run-subscription-cost.ts'
import type { QuotaPacingCalibration, QuotaPacingReading } from './subscription-pacing.ts'

/** Recent quota windows searched per harness for the latest usable calibration. */
export const SUBSCRIPTION_PACING_WINDOW_LIMIT = 8

export const SUBSCRIPTION_PACING_FACTS_SQL = `
  WITH paced(harness) AS (SELECT value FROM json_each(?)),
       quota_windows AS (
         SELECT a.harness AS harness, r.quota_resets_at AS resetsAt,
                MAX(r.quota_window_minutes) AS windowMinutes,
                MIN(r.quota_used_percent_start) AS usedPercentStart,
                MAX(r.quota_used_percent_end) AS usedPercentEnd,
                SUM(COALESCE(r.vendor_tokens, 0)) AS tokens
           FROM run r JOIN agent a ON a.name = r.agent
           JOIN paced p ON p.harness = a.harness
          WHERE a.billing = 'subscription'
            AND r.quota_used_percent_start IS NOT NULL
            AND r.quota_used_percent_end IS NOT NULL
            AND r.quota_window_minutes IS NOT NULL
            AND r.quota_resets_at IS NOT NULL
            AND r.quota_resets_at IN (
              SELECT r2.quota_resets_at
                FROM run r2 JOIN agent a2 ON a2.name = r2.agent
               WHERE a2.harness = a.harness AND a2.billing = 'subscription'
                 AND r2.quota_resets_at IS NOT NULL
               GROUP BY r2.quota_resets_at
               ORDER BY r2.quota_resets_at DESC
               LIMIT ?
            )
          GROUP BY a.harness, r.quota_resets_at
       ),
       qualified AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY harness ORDER BY resetsAt DESC) AS rank
           FROM quota_windows
          WHERE usedPercentEnd - usedPercentStart >= ? AND tokens > 0
       ),
       readings AS (
         SELECT a.harness, r.quota_used_percent_end AS usedPercentEnd,
                r.quota_window_minutes AS windowMinutes, r.quota_resets_at AS resetsAt,
                julianday(r.started_at) + r.latency_ms / 86400000.0 AS finishedAt,
                ROW_NUMBER() OVER (
                  PARTITION BY a.harness
                  ORDER BY julianday(r.started_at) + r.latency_ms / 86400000.0 DESC,
                           r.record_id DESC
                ) AS rank
           FROM run r JOIN agent a ON a.name = r.agent JOIN paced p ON p.harness = a.harness
          WHERE a.billing = 'subscription' AND r.status IN ('ok','failed')
            AND r.latency_ms IS NOT NULL AND r.quota_used_percent_end IS NOT NULL
            AND r.quota_window_minutes IS NOT NULL AND r.quota_resets_at IS NOT NULL
            AND ? >= r.quota_resets_at - r.quota_window_minutes * 60
            AND ? < r.quota_resets_at
       ),
       facts AS (
         SELECT p.harness,
                cr.usedPercentEnd AS readingUsedPercentEnd,
                cr.windowMinutes AS readingWindowMinutes,
                cr.resetsAt AS readingResetsAt, cr.finishedAt AS readingFinishedAt,
                q.tokens AS calibrationTokens,
                q.usedPercentEnd - q.usedPercentStart AS calibrationPercent,
                q.windowMinutes AS calibrationWindowMinutes,
                CASE
                  WHEN cr.resetsAt IS NOT NULL THEN cr.resetsAt
                  WHEN q.resetsAt IS NULL THEN NULL
                  WHEN ? < q.resetsAt THEN q.resetsAt
                  ELSE q.resetsAt +
                       (CAST((? - q.resetsAt) / (q.windowMinutes * 60) AS INTEGER) + 1) *
                       q.windowMinutes * 60
                END AS currentResetsAt
           FROM paced p
           LEFT JOIN readings cr ON cr.harness = p.harness AND cr.rank = 1
           LEFT JOIN qualified q ON q.harness = p.harness AND q.rank = 1
       )
  SELECT f.*,
         COALESCE((
           SELECT SUM(COALESCE(r.vendor_tokens, 0))
             FROM run r JOIN agent a ON a.name = r.agent
            WHERE a.harness = f.harness AND a.billing = 'subscription'
              AND r.status IN ('ok','failed') AND r.latency_ms IS NOT NULL
              AND ((f.readingFinishedAt IS NOT NULL
                    AND julianday(r.started_at) + r.latency_ms / 86400000.0 > f.readingFinishedAt
                    AND r.quota_resets_at IS NULL)
                OR (f.readingFinishedAt IS NULL AND f.currentResetsAt IS NOT NULL
                    AND julianday(r.started_at) + r.latency_ms / 86400000.0 >=
                        julianday(f.currentResetsAt - f.calibrationWindowMinutes * 60, 'unixepoch')
                    AND julianday(r.started_at) + r.latency_ms / 86400000.0 <
                        julianday(f.currentResetsAt, 'unixepoch')))
         ), 0) AS tokensSinceReading
    FROM facts f`

export type SubscriptionPacingFacts = {
  reading: QuotaPacingReading | null
  tokensSinceReading: number
  calibration: QuotaPacingCalibration | null
}

type StoredPacingFacts = {
  harness: string
  readingUsedPercentEnd: number | null
  readingWindowMinutes: number | null
  readingResetsAt: number | null
  calibrationTokens: number | null
  calibrationPercent: number | null
  calibrationWindowMinutes: number | null
  currentResetsAt: number | null
  tokensSinceReading: number
}

/** One query supplies current readings, the most recent qualified calibration, and current tokens. */
export function subscriptionPacingFacts(
  database: Database,
  harnesses: readonly string[],
  now = Date.now(),
): Map<string, SubscriptionPacingFacts> {
  if (harnesses.length === 0) return new Map()
  const nowSeconds = now / 1000
  const rows = database
    .query(SUBSCRIPTION_PACING_FACTS_SQL)
    .all(
      JSON.stringify([...new Set(harnesses)]),
      SUBSCRIPTION_PACING_WINDOW_LIMIT,
      QUOTA_MIN_WINDOW_PERCENT,
      nowSeconds,
      nowSeconds,
      nowSeconds,
      nowSeconds,
    ) as StoredPacingFacts[]

  return new Map(
    rows.map((row) => {
      const reading =
        row.readingUsedPercentEnd !== null &&
        row.readingWindowMinutes !== null &&
        row.readingResetsAt !== null
          ? {
              usedPercentEnd: row.readingUsedPercentEnd,
              windowMinutes: row.readingWindowMinutes,
              resetsAt: row.readingResetsAt,
            }
          : null
      const calibration =
        row.calibrationTokens !== null &&
        row.calibrationPercent !== null &&
        row.calibrationPercent > 0 &&
        row.calibrationWindowMinutes !== null &&
        row.currentResetsAt !== null
          ? {
              tokensPerPercent: row.calibrationTokens / row.calibrationPercent,
              windowMinutes: row.calibrationWindowMinutes,
              resetsAt: row.currentResetsAt,
            }
          : null
      return [
        row.harness,
        { reading, tokensSinceReading: row.tokensSinceReading, calibration },
      ] as const
    }),
  )
}
