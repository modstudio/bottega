// concern: workflow-run-obligation-evidence
/** Gathers cursor-bound run-chain facts without deciding workflow obligations. */

import type { Database } from 'bun:sqlite'
import { readMergedBranchLandingPrNumbers } from '../branch/branch-landing-records.ts'
import { PENDING_SCORE_WHERE } from '../evidence/pending-score-sql.ts'
import { resolveLocalRun } from '../identity/identity-local-run.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import { createdAfterStepActivation } from './workflow-cursor-trail.ts'
import type {
  EarlierStepRunEvidence,
  LandedEarlierStepRunEvidence,
  WorkflowRunChainEvidence,
} from './workflow-run-obligation.ts'

function dispatchCreditedTurn(
  turn: { stepSlug: string; startedAt: string },
  currentStepSlug: string,
  stepActivatedAt?: string,
): boolean {
  return (
    turn.stepSlug === currentStepSlug ||
    (stepActivatedAt !== undefined && createdAfterStepActivation(turn.startedAt, stepActivatedAt))
  )
}

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
          dispatchCreditedTurn(
            { stepSlug: row.step_slug, startedAt: row.started_at },
            stepSlug,
            stepActivatedAt,
          ),
      )
      .map((row) => row.root_record_id),
  )
  if (!creditedRoots.size) return []
  const rootPlaceholders = [...creditedRoots].map(() => '?').join(',')
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
          AND r.record_id IN (${rootPlaceholders})
        ORDER BY r.number`,
    )
    .all(...creditedRoots)
  return rows.map((row) => ({
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
      .filter((row) =>
        dispatchCreditedTurn(
          { stepSlug: row.step_slug, startedAt: row.created_at },
          currentStepSlug,
          stepActivatedAt,
        ),
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
  const identified = earlierStepRuns.map((run) => ({
    run,
    recordId: resolveLocalRun(database, { kind: 'number', number: run.number }).record_id,
  }))
  const byRecordId = new Map(identified.map(({ recordId, run }) => [recordId, run]))
  const placeholders = earlierStepRuns.map(() => '?').join(',')
  const rows = database
    .query<{ record_id: string; project_record_id: string; branch: string }, string[]>(
      `SELECT root.record_id,root.project_record_id,
              COALESCE(newest.branch,newest.branch_kept) branch
         FROM run root
         JOIN run newest
           ON newest.record_id=(
             SELECT turn.record_id FROM run turn
              WHERE turn.record_id=root.record_id OR turn.parent_run_record_id=root.record_id
              ORDER BY turn.turn DESC,turn.number DESC LIMIT 1
           )
        WHERE root.parent_run_record_id IS NULL
          AND root.record_id IN (${placeholders})
          AND COALESCE(newest.branch,newest.branch_kept) IS NOT NULL
        ORDER BY root.number`,
    )
    .all(...identified.map(({ recordId }) => recordId))
  const landed = readMergedBranchLandingPrNumbers(
    database,
    rows.map((row) => ({ projectRecordId: row.project_record_id, branch: row.branch })),
  )
  const prNumberByBranch = new Map(
    landed.map((row) => [JSON.stringify([row.projectRecordId, row.branch]), row.prNumber]),
  )
  return rows.flatMap((row) => {
    const earlier = byRecordId.get(row.record_id)
    const prNumber = prNumberByBranch.get(JSON.stringify([row.project_record_id, row.branch]))
    return earlier && prNumber !== undefined ? [{ ...earlier, prNumber }] : []
  })
}
