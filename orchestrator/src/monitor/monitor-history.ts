// concern: monitor history
/** Reads and normalizes the bounded monitor history for command presentation. */

import { db } from '../database/db.ts'
import type { MonitorSeverity } from '../review/review-vocabulary.ts'
import { monitorReleasedBefore } from './monitor-retention-state.ts'
import {
  type HumanMonitorCondition,
  MONITOR_HISTORY_DEFAULT_LIMIT,
  type MonitorHistoryRow,
} from './monitor-types.ts'

export function monitorHistory(limit = MONITOR_HISTORY_DEFAULT_LIMIT): MonitorHistoryRow[] {
  return (
    db()
      .query(
        `SELECT i.record_id,i.number AS id,i.started_at,i.finished_at,i.trigger,i.findings,i.errors,
         i.host_load,(SELECT json_group_array(json_object(
       'kind',c.kind,'subject',c.subject,'condition_since',c.condition_since,
       'age_ms',c.age_ms,'detail',c.detail,'action',c.action,'issue_key',c.issue_key,
       'severity',c.severity
       ,'owner_session_id',c.owner_session_id,'delivered_at',c.delivered_at
     )) FROM monitor_condition c WHERE c.invocation_record_id=i.record_id) conditions
       FROM monitor_invocation i ORDER BY i.started_at DESC,i.record_id DESC LIMIT ?`,
      )
      .all(limit) as (Omit<MonitorHistoryRow, 'conditions' | 'host_load'> & {
      conditions: string | null
      host_load: string | null
    })[]
  ).map((row) => ({
    ...row,
    conditions: JSON.parse(row.conditions ?? '[]') as unknown[],
    host_load: row.host_load ? JSON.parse(row.host_load) : null,
  }))
}

export function monitorHistoryReleasedBefore(): string | null {
  return monitorReleasedBefore(db())
}

export function displayConditions(conditions: unknown[]): HumanMonitorCondition[] {
  return conditions.map((raw): HumanMonitorCondition => {
    const condition = raw as {
      kind: string
      subject: string
      age_ms: number | null
      detail: string
      action: string
      issue_key?: string | null
      severity?: MonitorSeverity | null
      owner_session_id?: string | null
    }
    return {
      kind: condition.kind,
      subject: condition.subject,
      ageMs: condition.age_ms,
      detail: condition.detail,
      action: condition.action,
      issueKey: condition.issue_key,
      severity: condition.severity,
      ownerSession: condition.owner_session_id,
    }
  })
}
