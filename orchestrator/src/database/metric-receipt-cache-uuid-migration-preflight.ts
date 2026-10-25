import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

/** Refuse a UUID-key rebuild that would drop or merge an invalid metric identity. */
function invalidMetricIdentityDays(database: Database): string[] {
  return database
    .query<{ day: string }, []>(
      `SELECT day FROM metric
       WHERE record_id IS NULL OR trim(record_id)=''
          OR record_id IN (
            SELECT record_id FROM metric
            WHERE record_id IS NOT NULL AND trim(record_id)<>''
            GROUP BY record_id HAVING COUNT(*) > 1
          )
       ORDER BY day`,
    )
    .all()
    .map((row) => row.day)
}

/** Run the metric identity preflight before either table rebuild starts. */
export function assertMetricIdentities(database: Database): void {
  const days = invalidMetricIdentityDays(database)
  if (!days.length) return
  throw new Error(
    `refusing metric/receipt cache UUID-key migration: metric.record_id is NULL, empty, or duplicate for days [${days.join(',')}]\n` +
      `cleared by: repair the named metric identities, then run \`${PLATFORM_SLUG} machine migrate\``,
  )
}
