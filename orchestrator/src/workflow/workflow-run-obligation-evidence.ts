// concern: workflow-run-obligation-evidence
/** Gathers cursor-bound run-chain facts without deciding workflow obligations. */

import type { Database } from 'bun:sqlite'
import { PENDING_SCORE_WHERE } from '../evidence/pending-score-sql.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import { createdAfterStepActivation } from './workflow-cursor-trail.ts'
import type {
  EarlierStepRunEvidence,
  LandedEarlierStepRunEvidence,
  WorkflowRunChainEvidence,
} from './workflow-run-obligation.ts'

export function gatherWorkflowRunChains(
  cursorRecordId: string,
  jobs: readonly string[],
  database: Database,
  stepSlug?: string,
  stepActivatedAt?: string,
): WorkflowRunChainEvidence[] {
  if (!jobs.length) return []
  const jobPlaceholders = jobs.map(() => '?').join(',')
  const bindingRows = database
    .query<{ root_record_id: string; step_slug: string; started_at: string }, (string | number)[]>(
      `SELECT root.record_id AS root_record_id,bound.step_slug,bound.started_at
         FROM run root JOIN run bound
           ON bound.record_id=root.record_id OR bound.parent_run_record_id=root.record_id
        WHERE root.parent_run_record_id IS NULL
          AND root.job IN (${jobPlaceholders})
          AND bound.cursor_record_id=?`,
    )
    .all(...jobs, cursorRecordId)
  const creditedRoots = new Set(
    bindingRows
      .filter(
        (row) =>
          stepSlug === undefined ||
          row.step_slug === stepSlug ||
          (stepActivatedAt !== undefined &&
            createdAfterStepActivation(row.started_at, stepActivatedAt)),
      )
      .map((row) => row.root_record_id),
  )
  if (!creditedRoots.size) return []
  const rows = database
    .query<
      {
        record_id: string
        number: number
        job: string
        status: string
        needs_verdict: number
      },
      (string | number)[]
    >(
      `SELECT r.record_id,r.number,r.job,
              COALESCE((SELECT latest.status FROM run latest
                         WHERE latest.parent_run_record_id=r.record_id
                         ORDER BY latest.turn DESC,latest.number DESC LIMIT 1),r.status) AS status,
              CASE WHEN ${PENDING_SCORE_WHERE} THEN 1 ELSE 0 END AS needs_verdict
         FROM run r LEFT JOIN score s ON s.run_record_id=r.record_id
        WHERE r.parent_run_record_id IS NULL
          AND EXISTS (SELECT 1 FROM run bound
                       WHERE (bound.record_id=r.record_id OR bound.parent_run_record_id=r.record_id)
                         AND bound.cursor_record_id=?)
          AND r.job IN (${jobPlaceholders})
        ORDER BY r.number`,
    )
    .all(cursorRecordId, ...jobs)
  return rows
    .filter((row) => creditedRoots.has(row.record_id))
    .map((row) => ({
      number: row.number,
      job: row.job,
      terminal: TERMINAL_RUN_STATUS_SET.has(row.status),
      needsVerdict: row.needs_verdict === 1,
    }))
}

export function gatherEarlierStepWorkflowRunChains(
  cursorRecordId: string,
  jobs: readonly string[],
  currentStepSlug: string,
  stepActivatedAt: string,
  database: Database,
): EarlierStepRunEvidence[] {
  if (!jobs.length) return []
  const jobPlaceholders = jobs.map(() => '?').join(',')
  const rows = database
    .query<{ number: number; step_slug: string; created_at: string }, (string | number)[]>(
      `SELECT root.number,bound.step_slug,bound.started_at AS created_at
         FROM run root JOIN run bound
           ON bound.record_id=root.record_id OR bound.parent_run_record_id=root.record_id
        WHERE root.parent_run_record_id IS NULL
          AND root.job IN (${jobPlaceholders})
          AND bound.cursor_record_id=?
        ORDER BY root.number,bound.turn DESC,bound.number DESC`,
    )
    .all(...jobs, cursorRecordId)
  const gathered: EarlierStepRunEvidence[] = []
  const seen = new Set<number>()
  const creditedByDispatch = new Set(
    rows
      .filter(
        (row) =>
          row.step_slug === currentStepSlug ||
          createdAfterStepActivation(row.created_at, stepActivatedAt),
      )
      .map((row) => row.number),
  )
  for (const row of rows) {
    if (
      row.step_slug === currentStepSlug ||
      seen.has(row.number) ||
      creditedByDispatch.has(row.number)
    )
      continue
    seen.add(row.number)
    gathered.push({ number: row.number, stepSlug: row.step_slug })
  }
  return gathered
}

export function gatherLandedEarlierStepWorkflowRunChains(
  earlierStepRuns: readonly EarlierStepRunEvidence[],
  database: Database,
): LandedEarlierStepRunEvidence[] {
  if (!earlierStepRuns.length) return []
  const byNumber = new Map(earlierStepRuns.map((run) => [run.number, run]))
  const placeholders = earlierStepRuns.map(() => '?').join(',')
  const rows = database
    .query<{ number: number; pr_number: number }, number[]>(
      `SELECT root.number,landing.pr_number
         FROM run root
         JOIN run newest
           ON newest.record_id=(
             SELECT turn.record_id FROM run turn
              WHERE turn.record_id=root.record_id OR turn.parent_run_record_id=root.record_id
              ORDER BY turn.turn DESC,turn.number DESC LIMIT 1
           )
         JOIN branch_landing_record landing
           ON landing.project_record_id=root.project_record_id
          AND landing.branch=COALESCE(newest.branch,newest.branch_kept)
          AND landing.merged_at IS NOT NULL
        WHERE root.parent_run_record_id IS NULL
          AND root.number IN (${placeholders})
        ORDER BY root.number`,
    )
    .all(...earlierStepRuns.map((run) => run.number))
  return rows.flatMap((row) => {
    const earlier = byNumber.get(row.number)
    return earlier ? [{ ...earlier, prNumber: row.pr_number }] : []
  })
}
