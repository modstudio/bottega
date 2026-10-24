// concern: monitor issue filing
/** Reuses or files durable issues for unavailable monitor detectors. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { fileIssue } from '../mcp/mcp.ts'
import type { MonitorCondition } from './monitor-types.ts'

export async function fileUnavailableMonitorIssues(
  database: Database,
  conditions: MonitorCondition[],
  errors: string[],
  invocationRecordId: string,
  invocationNumber: number,
): Promise<void> {
  const unavailable = conditions.filter(
    (condition) => condition.kind === 'detector-unavailable' || condition.kind === 'dead-lock',
  )
  for (const condition of unavailable) {
    const prior = database
      .query(
        `SELECT condition.issue_key FROM monitor_condition condition
         JOIN monitor_invocation invocation
           ON invocation.record_id=condition.invocation_record_id
         WHERE condition.kind=? AND condition.subject=? AND condition.issue_key IS NOT NULL
         ORDER BY invocation.started_at DESC,condition.record_id DESC LIMIT 1`,
      )
      .get(condition.kind, condition.subject) as { issue_key: string } | null
    if (prior) {
      condition.issueKey = prior.issue_key
      continue
    }
    try {
      const filed = await fileIssue(
        {
          kind: 'defect',
          title: `Monitor cannot safely handle ${condition.subject}`,
          what_happened: `Monitor cannot safely handle ${condition.subject}: ${condition.detail}`,
          expected:
            'The monitor needs a machine-readable detector or an established command so it can report or repair this condition without inference or direct database writes.',
          reproduce_command: `${PLATFORM_SLUG} machine monitor`,
          environment: `monitor invocation ${invocationNumber}; affected machine/project is named in the evidence`,
          evidence: `monitor invocation ${invocationNumber}; ${condition.kind} ${condition.subject}; ${condition.detail}`,
          not_established:
            'The missing interface design and remediation policy are not established by the monitor.',
        },
        {
          kind: 'monitor',
          invocationId: invocationNumber,
          affectedProject: condition.affectedProject ?? PLATFORM_SLUG,
        },
        PLATFORM_SLUG,
      )
      condition.issueKey = filed.key
      database
        .query(
          'UPDATE monitor_condition SET issue_key=? WHERE invocation_record_id=? AND kind=? AND subject=?',
        )
        .run(filed.key, invocationRecordId, condition.kind, condition.subject)
    } catch (cause) {
      errors.push(
        `could not file ${condition.kind} issue: ${String((cause as Error).message ?? cause)}`,
      )
    }
  }
}
