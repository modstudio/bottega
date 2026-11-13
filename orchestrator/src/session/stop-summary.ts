// concern: session stop summary
/** Gathers the calling session's read-only Stop facts. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, sessionId } from '../database/db.ts'
import { UNSCORED_WHERE } from '../evidence/evidence-query.ts'
import { heldTreeInFlight, LANDING_TREE_JOB } from '../landing-tree/landing-tree.ts'
import { RUN_LIVE_STATUSES } from '../run/run-status.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import {
  listWorkflowCursors,
  type WorkflowCursorListRow,
} from '../workflow/workflow-cursor-list.ts'
import {
  decideStopSummary,
  type StopSummaryDecision,
  type StopSummaryOwedItem,
} from './stop-summary-decision.ts'

type CountRow = { count: number }
type OwedRunRow = {
  record_id: string
  number: number
  job: string
  launch_key: string | null
  label: string | null
  owed_at: string
}
type HeldTreeRow = {
  record_id: string
  number: number
  job: string
  repo: string | null
  branch: string | null
  worktree: string | null
  close_out_attempted_at: string | null
}
type ActiveLandingRow = { project: string; branch: string }
type HookNote = { label: string; project: string; last_seen_at?: string }

function cursorArg(row: WorkflowCursorListRow, key: 'branch' | 'worktree'): string | null {
  try {
    const value = JSON.parse(row.args) as Record<string, unknown>
    return typeof value[key] === 'string' ? value[key] : null
  } catch {
    return null
  }
}

function landingTreeIsActive(
  tree: HeldTreeRow,
  cursors: readonly WorkflowCursorListRow[],
  landings: readonly ActiveLandingRow[],
): boolean {
  if (tree.job !== LANDING_TREE_JOB) return false
  if (landings.some((item) => item.project === tree.repo && item.branch === tree.branch))
    return true
  const cursor = cursors.find(
    (item) =>
      item.workflow_slug === 'ship-task' &&
      item.project === tree.repo &&
      cursorArg(item, 'branch') === tree.branch &&
      cursorArg(item, 'worktree') === tree.worktree,
  )
  if (!cursor || !tree.worktree) return false
  return Boolean(
    heldTreeInFlight({
      treePath: tree.worktree,
      project: tree.repo,
      branch: tree.branch,
      cursor: {
        id: cursor.id,
        workflow: cursor.workflow_slug,
        step: cursor.step_slug,
        claimed: true,
        project: cursor.project,
        branch: cursorArg(cursor, 'branch'),
        worktree: cursorArg(cursor, 'worktree'),
      },
      openPr: null,
      hold: 'landing-progress',
      treeClean: false,
      treeHead: null,
    }),
  )
}

function hookNotes(now: string): StopSummaryOwedItem[] {
  try {
    const parsed = JSON.parse(process.env.BOTTEGA_STOP_SUMMARY_NOTES ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value): StopSummaryOwedItem[] => {
      if (!value || typeof value !== 'object') return []
      const note = value as Partial<HookNote>
      if (!note.label || !note.project) return []
      return [
        {
          kind: 'note',
          identity: note.label,
          label: `note ${note.label} not handed over`,
          command: `${PLATFORM_SLUG} board post --audience architects:${note.project} ...`,
          owedAt: note.last_seen_at ?? now,
        },
      ]
    })
  } catch {
    return []
  }
}

export async function sessionStopSummary(
  options: { now?: string; previousBlockKey?: string | null; session?: string } = {},
  database: Database = db(),
): Promise<StopSummaryDecision> {
  const session = options.session ?? sessionId()
  if (!session) throw new Error('session identity is unavailable')
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
  const incompleteReviews =
    database
      .query<CountRow, [string]>(
        `SELECT COUNT(DISTINCT review.record_id) count FROM review
       JOIN review_lens lens ON lens.review_record_id=review.record_id
       JOIN run ON run.record_id=lens.run_record_id
      WHERE run.session_id=? AND (review.completed_at IS NULL OR EXISTS
        (SELECT 1 FROM review_finding finding WHERE finding.review_record_id=review.record_id
          AND finding.disposition IS NULL))`,
      )
      .get(session)?.count ?? 0
  const activeLandings = database
    .query<ActiveLandingRow, [string]>(
      "SELECT project,branch FROM landing WHERE session_id=? AND status IN ('queued','running')",
    )
    .all(session)
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
    .query<HeldTreeRow, [string]>(
      `SELECT record_id,number,job,repo,branch,worktree,close_out_attempted_at
         FROM run WHERE session_id=? AND parent_run_record_id IS NULL
          AND close_out_outcome='held' ORDER BY number`,
    )
    .all(session)
  const activeTrees = heldTrees.filter((tree) => landingTreeIsActive(tree, cursors, activeLandings))
  const owedItems: StopSummaryOwedItem[] = [
    ...owedRuns.map((run) => ({
      kind: 'run' as const,
      identity: run.record_id,
      label: `run ${run.number} ${run.job}${run.launch_key ? ` ${run.launch_key}` : ''} unscored`,
      command: `${PLATFORM_SLUG} score ${run.number} (see ${PLATFORM_SLUG} score --help)`,
      owedAt: run.owed_at,
    })),
    ...heldTrees
      .filter((tree) => !activeTrees.includes(tree))
      .map((tree) => ({
        kind: tree.job === LANDING_TREE_JOB ? ('landing-tree' as const) : ('worktree' as const),
        identity: tree.record_id,
        label:
          tree.job === LANDING_TREE_JOB
            ? `landing tree ${tree.worktree ?? `run ${tree.number}`} is held`
            : `worktree for run ${tree.number} is held`,
        command:
          tree.job === LANDING_TREE_JOB && tree.worktree
            ? `${PLATFORM_SLUG} tree remove ${tree.worktree}`
            : `${PLATFORM_SLUG} run close-out ${tree.number}`,
        owedAt: tree.close_out_attempted_at ?? now,
      })),
    ...hookNotes(now),
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
    incompleteReviews,
    inFlightLandings: activeLandings.length + activeTrees.length,
    owedItems,
    previousBlockKey: options.previousBlockKey ?? null,
  })
}
