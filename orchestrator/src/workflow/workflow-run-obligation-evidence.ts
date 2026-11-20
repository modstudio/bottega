// concern: workflow-run-obligation-evidence
/** Gathers cursor-bound run-chain facts without deciding workflow obligations. */

import type { Database } from 'bun:sqlite'
import { PENDING_SCORE_WHERE } from '../evidence/pending-score-sql.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import type { WorkflowRunChainEvidence } from './workflow-floor.ts'

export function gatherWorkflowRunChains(
  cursorRecordId: string,
  jobs: readonly string[],
  database: Database,
  stepSlug?: string,
): WorkflowRunChainEvidence[] {
  if (!jobs.length) return []
  const jobPlaceholders = jobs.map(() => '?').join(',')
  const stepClause = stepSlug === undefined ? '' : ' AND r.step_slug=?'
  const rows = database
    .query<
      { number: number; job: string; status: string; needs_verdict: number },
      (string | number)[]
    >(
      `SELECT r.number,r.job,r.status,
              CASE WHEN ${PENDING_SCORE_WHERE} THEN 1 ELSE 0 END AS needs_verdict
         FROM run r LEFT JOIN score s ON s.run_record_id=r.record_id
        WHERE r.parent_run_record_id IS NULL
          AND r.cursor_record_id=?${stepClause}
          AND r.job IN (${jobPlaceholders})
        ORDER BY r.number`,
    )
    .all(cursorRecordId, ...(stepSlug === undefined ? [] : [stepSlug]), ...jobs)
  return rows.map((row) => ({
    number: row.number,
    job: row.job,
    terminal: TERMINAL_RUN_STATUS_SET.has(row.status),
    needsVerdict: row.needs_verdict === 1,
  }))
}
