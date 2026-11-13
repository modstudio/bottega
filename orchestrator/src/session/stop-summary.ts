// concern: session stop summary
/** Gathers the calling session's read-only Stop facts. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { cursorFacts } from '../close/close-out-in-flight.ts'
import { db } from '../database/db.ts'
import { UNSCORED_WHERE } from '../evidence/evidence-query.ts'
import { LANDING_TREE_JOB, shipCursorWorksTree } from '../landing-tree/landing-tree.ts'
import { RUN_LIVE_STATUSES } from '../run/run-status.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import {
  listWorkflowCursors,
  type WorkflowCursorListRow,
} from '../workflow/workflow-cursor-list.ts'
import { activeLandings } from './session-close-out.ts'
import {
  decideStopSummary,
  type StopSummaryDecision,
  type StopSummaryNote,
  type StopSummaryOwedItem,
} from './stop-summary-decision.ts'
import {
  classifyStopSummaryReviews,
  type StopSummaryReviewLensRow,
} from './stop-summary-reviews.ts'

type CountRow = { count: number }
type OwedRunRow = {
  record_id: string
  number: number
  job: string
  launch_key: string | null
  label: string | null
  owed_at: string
}
export type StopSummaryHeldTreeRow = {
  record_id: string
  number: number
  job: string
  repo: string | null
  branch: string | null
  worktree: string | null
  close_out_attempted_at: string | null
}
export type StopSummaryActiveLandingRow = { project: string; branch: string }
export type StopSummaryHookNote = {
  label: string
  project: string
  last_seen_at?: string | null
}

export function landingTreeIsActive(
  tree: StopSummaryHeldTreeRow,
  cursors: readonly WorkflowCursorListRow[],
  landings: readonly StopSummaryActiveLandingRow[],
): boolean {
  if (tree.job !== LANDING_TREE_JOB) return false
  if (landings.some((item) => item.project === tree.repo && item.branch === tree.branch))
    return true
  const treePath = tree.worktree
  if (!treePath) return false
  return cursors.some((cursor) =>
    shipCursorWorksTree({ treePath, project: tree.repo, branch: tree.branch }, cursorFacts(cursor)),
  )
}

export function hookNotes(notes: readonly StopSummaryHookNote[]): StopSummaryNote[] {
  return notes.map((note) => ({
    label: `note ${note.label} not handed over`,
    command: `${PLATFORM_SLUG} board post --audience architects:${note.project} (see ${PLATFORM_SLUG} board post --help)`,
  }))
}

function heldWorktreeCommand(tree: StopSummaryHeldTreeRow): string {
  return `${PLATFORM_SLUG} run close-out ${tree.number}`
}

export async function sessionStopSummary(
  options: {
    session: string
    previousBlockKey: string | null
    notes: readonly StopSummaryHookNote[]
    now?: string
  },
  database: Database = db(),
): Promise<StopSummaryDecision> {
  const session = options.session
  const now = options.now ?? new Date().toISOString()
  const cursors = await listWorkflowCursors({ session }, database)
  const questionCount =
    await taskFlowReadStore(database).openWorkflowQuestionCountForSession(session)
  const livePlaceholders = RUN_LIVE_STATUSES.map(() => '?').join(',')
  const liveRuns =
    database
      .query<CountRow, string[]>(
        `SELECT COUNT(*) count FROM run WHERE session_id=? AND status IN (${livePlaceholders})`,
      )
      .get(session, ...RUN_LIVE_STATUSES)?.count ?? 0
  const reviewRows = database
    .query<StopSummaryReviewLensRow, [string]>(
      `SELECT review.record_id review_record_id,review.number,review.completed_at,review.outdated_at,
              run.status run_status,
              strftime('%Y-%m-%dT%H:%M:%fZ',julianday(run.started_at)+COALESCE(run.latency_ms,0)/86400000.0) finished_at,
              (SELECT COUNT(*) FROM review_finding finding
                WHERE finding.review_record_id=review.record_id AND finding.disposition IS NULL) open_findings
         FROM review
         JOIN review_lens lens ON lens.review_record_id=review.record_id
         JOIN run ON run.record_id=lens.run_record_id
        WHERE EXISTS (SELECT 1 FROM review_lens owned_lens
          JOIN run owned_run ON owned_run.record_id=owned_lens.run_record_id
          WHERE owned_lens.review_record_id=review.record_id AND owned_run.session_id=?)
        ORDER BY review.number,lens.record_id`,
    )
    .all(session)
  const reviews = classifyStopSummaryReviews(reviewRows)
  const sessionLandings = activeLandings(database, session)
  const activeLandingTrees = database
    .query<StopSummaryActiveLandingRow, []>(
      `SELECT project.name project,landing.branch FROM landing
       JOIN project ON project.record_id=landing.project_record_id
       WHERE landing.status IN ('queued','running')`,
    )
    .all()
  const owedRuns = database
    .query<OwedRunRow, [string]>(
      `SELECT r.record_id,r.number,r.job,r.launch_key,
              substr(COALESCE(r.label,r.prompt_head),1,60) label,
              strftime('%Y-%m-%dT%H:%M:%fZ',julianday(r.started_at)+COALESCE(r.latency_ms,0)/86400000.0) owed_at
         FROM run r LEFT JOIN score s ON s.run_record_id=r.record_id
        WHERE r.session_id=? AND ${UNSCORED_WHERE} ORDER BY r.number`,
    )
    .all(session)
  const heldTrees = database
    .query<StopSummaryHeldTreeRow, [string]>(
      `SELECT record_id,number,job,repo,branch,worktree,close_out_attempted_at
         FROM run WHERE session_id=? AND parent_run_record_id IS NULL
          AND close_out_outcome='held' ORDER BY number`,
    )
    .all(session)
  const activeTrees = heldTrees.filter((tree) =>
    landingTreeIsActive(tree, cursors, activeLandingTrees),
  )
  const owedItems: StopSummaryOwedItem[] = [
    ...reviews.owedItems,
    ...owedRuns.map((run) => ({
      label: `run ${run.number} ${run.job}${run.launch_key ? ` ${run.launch_key}` : ''} unscored`,
      command: `${PLATFORM_SLUG} score ${run.number} (see ${PLATFORM_SLUG} score --help)`,
      owedAt: run.owed_at,
    })),
    ...heldTrees
      .filter((tree) => !activeTrees.includes(tree))
      .map((tree) => ({
        label:
          tree.job === LANDING_TREE_JOB
            ? `landing tree ${tree.worktree ?? `run ${tree.number}`} is held`
            : `worktree for run ${tree.number} (${tree.job}) is held`,
        command:
          tree.job === LANDING_TREE_JOB && tree.worktree
            ? `${PLATFORM_SLUG} tree remove ${tree.worktree}`
            : heldWorktreeCommand(tree),
        owedAt: tree.close_out_attempted_at ?? now,
      })),
  ]
  return decideStopSummary({
    now,
    questionCount,
    cursors: cursors.map((cursor) => ({
      key: cursor.workflow_key || null,
      workflow: cursor.workflow_slug,
      step: cursor.step_slug,
      ordinal: cursor.ordinal + 1,
      total: cursor.total_steps,
    })),
    liveRuns,
    incompleteReviews: reviews.incompleteReviews,
    inFlightLandings: sessionLandings.length + activeTrees.length,
    owedItems,
    notes: hookNotes(options.notes),
    previousBlockKey: options.previousBlockKey ?? null,
  })
}
