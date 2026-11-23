// concern: monitor-collector-leg-announcement
/** Applies sustained collector-leg failure notices without failing the monitor pass. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  COLLECTOR_LEG_FAILURE_NOTICE_PREFIX,
  decideCollectorLegFailureAnnouncement,
} from './collector-leg-announcement.ts'
import type { CollectorLegFailure } from './collector-leg-conditions.ts'
import {
  announceHostedPressureActions,
  type HostedPressureAnnouncementDependencies,
} from './monitor-hosted-pressure.ts'

function previousPassNeedsCollectorLegNoticeReconciliation(database: Database): boolean {
  return (
    database
      .query(
        `SELECT 1 present
           FROM monitor_condition condition
           JOIN monitor_invocation invocation
             ON invocation.record_id=condition.invocation_record_id
          WHERE (condition.kind='collector-leg-failure'
                 OR (condition.kind='observation-error'
                     AND condition.detail LIKE 'collector leg announcement failed:%'))
            AND invocation.finished_at IS NOT NULL
            AND invocation.started_at=(
              SELECT MAX(started_at) FROM monitor_invocation WHERE finished_at IS NOT NULL
            )
          LIMIT 1`,
      )
      .get() !== null
  )
}

/** Reconcile collector-leg notices and return an observation error on board failure. */
export async function announceCollectorLegFailures(
  database: Database,
  failures: readonly CollectorLegFailure[],
  clock: number,
  dependencies: HostedPressureAnnouncementDependencies = {},
): Promise<{ errors: string[] }> {
  if (failures.length === 0 && !previousPassNeedsCollectorLegNoticeReconciliation(database))
    return { errors: [] }
  try {
    await announceHostedPressureActions(
      (messages) => decideCollectorLegFailureAnnouncement(failures, messages),
      dependencies,
      clock,
      {
        prefix: COLLECTOR_LEG_FAILURE_NOTICE_PREFIX,
        audience: `architects:${PLATFORM_SLUG}`,
      },
    )
    return { errors: [] }
  } catch (error) {
    return { errors: [`collector leg announcement failed: ${String(error)}`] }
  }
}
