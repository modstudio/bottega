// concern: workflow-run-obligation-evidence
/** Gathers cursor-bound run-chain facts without deciding workflow obligations. */

import type { Database } from 'bun:sqlite'
import { PENDING_SCORE_WHERE } from '../evidence/pending-score-sql.ts'
import { reviewLineage } from '../review/review-lineage-store.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import { resolveBranchUnderReview } from './workflow-review-owed-checkout.ts'
import type {
  EarlierStepDispatchEvidence,
  WorkflowRunChainEvidence,
} from './workflow-run-obligation.ts'

export function gatherWorkflowRunChains(
  cursorRecordId: string,
  jobs: readonly string[],
  database: Database,
  stepSlug?: string,
): WorkflowRunChainEvidence[] {
  if (!jobs.length) return []
  const jobPlaceholders = jobs.map(() => '?').join(',')
  const stepClause = stepSlug === undefined ? '' : ' AND bound.step_slug=?'
  const rows = database
    .query<
      { number: number; job: string; status: string; needs_verdict: number },
      (string | number)[]
    >(
      `SELECT r.number,r.job,
              COALESCE((SELECT latest.status FROM run latest
                         WHERE latest.parent_run_record_id=r.record_id
                         ORDER BY latest.turn DESC,latest.number DESC LIMIT 1),r.status) AS status,
              CASE WHEN ${PENDING_SCORE_WHERE} THEN 1 ELSE 0 END AS needs_verdict
         FROM run r LEFT JOIN score s ON s.run_record_id=r.record_id
        WHERE r.parent_run_record_id IS NULL
          AND EXISTS (SELECT 1 FROM run bound
                       WHERE (bound.record_id=r.record_id OR bound.parent_run_record_id=r.record_id)
                         AND bound.cursor_record_id=?${stepClause})
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

/** Gather the plain run, triage, branch, and architect-read facts for apply-findings. */
export function gatherEarlierStepDispatchEvidence(
  cursorRecordId: string,
  jobs: readonly string[],
  currentStepSlug: string,
  project: string,
  args: Record<string, string>,
  database: Database,
): EarlierStepDispatchEvidence | null {
  const resolved = resolveBranchUnderReview(project, args, database)
  if (resolved.action === 'refuse') return null
  const { branch, tip: branchTip } = resolved
  const lineage = reviewLineage(database, project, branch)
  const jobPlaceholders = jobs.map(() => '?').join(',')
  const candidates = jobs.length
    ? database
        .query<
          {
            number: number
            job: string
            status: string
            started_at: string
            latency_ms: number | null
            head_commit: string | null
            needs_verdict: number
          },
          (string | number)[]
        >(
          `SELECT DISTINCT r.number,r.job,bound.status,bound.started_at,bound.latency_ms,
                  bound.head_commit,CASE WHEN ${PENDING_SCORE_WHERE} THEN 1 ELSE 0 END AS needs_verdict
             FROM run bound
             JOIN run r ON r.record_id=COALESCE(bound.parent_run_record_id,bound.record_id)
             LEFT JOIN score s ON s.run_record_id=r.record_id
            WHERE bound.cursor_record_id=? AND bound.step_slug<>?
              AND r.job IN (${jobPlaceholders})
            ORDER BY r.number`,
        )
        .all(cursorRecordId, currentStepSlug, ...jobs)
        .map((row) => ({
          number: row.number,
          job: row.job,
          terminal: TERMINAL_RUN_STATUS_SET.has(row.status),
          terminalOk: row.status === 'ok',
          needsVerdict: row.needs_verdict === 1,
          finishedAt:
            row.latency_ms === null
              ? null
              : new Date(Date.parse(row.started_at) + row.latency_ms).toISOString(),
          headCommit: row.head_commit,
        }))
    : []
  const latestAcceptedDispositionAt =
    database
      .query<{ triaged_at: string | null }, string[]>(
        `SELECT MAX(rf.triaged_at) AS triaged_at
         FROM review_finding rf
         JOIN review_lens rl ON rl.review_record_id=rf.review_record_id
         JOIN run review_run ON review_run.record_id=rl.run_record_id
        WHERE review_run.project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND review_run.branch IN (${lineage.map(() => '?').join(',')})
          AND rf.disposition IN ('accepted','modified')`,
      )
      .get(project, ...lineage)?.triaged_at ?? null
  const reviewedTips = database
    .query<{ tip: string }, [string, string]>(
      `SELECT tip FROM review_read
        WHERE project_record_id=(SELECT record_id FROM project WHERE name=?) AND branch=?`,
    )
    .all(project, branch)
    .map(({ tip }) => tip)
  return { candidates, latestAcceptedDispositionAt, branchTip, reviewedTips }
}
