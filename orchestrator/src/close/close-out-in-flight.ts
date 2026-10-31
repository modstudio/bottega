// concern: close-out in-flight annotation
/** Gathers holder, cursor, and open-PR facts so a held close-out report can carry in-flight work. */

import { existsSync } from 'node:fs'
import { db } from '../database/db.ts'
import { gitResult } from '../git/git-environment.ts'
import { isReadOnlyRepositoryJob } from '../jobs/jobs.ts'
import {
  type HeldTreeHoldKind,
  type HeldTreeOpenPr,
  heldTreeInFlight,
  heldTreeLiveHolderInFlight,
  pullRequestLookupNeeded,
} from '../landing-tree/landing-tree.ts'
import {
  annotateHeldTreeDetail,
  type CloseOutReportResult,
  hasHeldInFlightAnnotation,
} from './close-out-report.ts'

const OPEN_PR_TIMEOUT_MS = 3000

type RunLandingFacts = {
  number: number
  job: string
  repo: string | null
  branch: string | null
  sessionId: string | null
}

type CursorRow = {
  id: number
  step_slug: string
  workflow_slug: string
  project: string
  args: string
}

function lookupRun(runId: string): RunLandingFacts | null {
  const row = db()
    .query('SELECT number,job,repo,branch,session_id FROM run WHERE record_id=?')
    .get(runId) as {
    number: number
    job: string
    repo: string | null
    branch: string | null
    session_id: string | null
  } | null
  if (!row) return null
  return {
    number: row.number,
    job: row.job,
    repo: row.repo,
    branch: row.branch,
    sessionId: row.session_id,
  }
}

function cursorArg(args: string, key: 'branch' | 'worktree'): string | null {
  try {
    const value = JSON.parse(args) as Record<string, unknown>
    return typeof value[key] === 'string' ? value[key] : null
  } catch {
    return null
  }
}

function lookupShipTaskCursor(
  sessionId: string,
  project: string,
  branch: string,
  treePath: string,
): CursorRow | null {
  const rows = db()
    .query(
      `SELECT number id, step_slug, workflow_slug, project, args
         FROM workflow_cursor
        WHERE session_id = ?
          AND project = ?
          AND workflow_slug = 'ship-task'
          AND state IN ('running','awaiting-ruling')
          AND json_extract(args, '$.branch') = ?
        ORDER BY number`,
    )
    .all(sessionId, project, branch) as CursorRow[]
  return rows.find((row) => cursorArg(row.args, 'worktree') === treePath) ?? null
}

function parseOpenPr(stdout: string): HeldTreeOpenPr | null {
  const rows = JSON.parse(stdout || '[]') as unknown
  if (!Array.isArray(rows) || !rows[0] || typeof rows[0] !== 'object') return null
  const { number, headRefOid } = rows[0] as { number?: unknown; headRefOid?: unknown }
  if (typeof number !== 'number' || number <= 0) return null
  return {
    ref: `#${number}`,
    headOid: typeof headRefOid === 'string' && headRefOid ? headRefOid : null,
  }
}

export function lookupOpenPr(
  cwd: string,
  branch: string,
  timeoutMs = OPEN_PR_TIMEOUT_MS,
): HeldTreeOpenPr | null {
  if (!branch || !cwd || !existsSync(cwd) || timeoutMs <= 0) return null
  try {
    const result = Bun.spawnSync(
      [
        'gh',
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'open',
        '--json',
        'number,headRefOid',
        '--limit',
        '1',
      ],
      { cwd, stdout: 'pipe', stderr: 'pipe', timeout: Math.min(OPEN_PR_TIMEOUT_MS, timeoutMs) },
    )
    return result.exitCode === 0 ? parseOpenPr(result.stdout.toString()) : null
  } catch {
    return null
  }
}

/**
 * Whether the tree holds no uncommitted tracked or untracked work.
 *
 * Uncommitted work is git status's own stdout. A warning on stderr with a clean exit is not work,
 * and a failed status leaves cleanliness unestablished, which keeps the hold blocking.
 */
function treeIsClean(treePath: string): boolean {
  const status = gitResult(['status', '--porcelain', '--untracked-files=all'], treePath)
  return status.ok && status.stdout.trim() === ''
}

/** The tree's HEAD commit, or null when it cannot be read. */
function treeHead(treePath: string): string | null {
  const head = gitResult(['rev-parse', 'HEAD'], treePath)
  const value = head.stdout.trim()
  return head.ok && value ? value : null
}

/**
 * The cursor row's own facts.
 *
 * Only a running or awaiting-ruling row is looked up at all, so the row that arrives claims this
 * tree rather than proving its session alive.
 */
function cursorFacts(row: CursorRow | null) {
  if (!row) return null
  return {
    id: row.id,
    workflow: row.workflow_slug,
    step: row.step_slug,
    claimed: true,
    project: row.project,
    branch: cursorArg(row.args, 'branch'),
    worktree: cursorArg(row.args, 'worktree'),
  }
}

function lookupCursor(run: RunLandingFacts, treePath: string): CursorRow | null {
  if (!run.sessionId || !run.repo || !run.branch) return null
  return lookupShipTaskCursor(run.sessionId, run.repo, run.branch, treePath)
}

function inFlightForHold(
  worktree: string,
  run: RunLandingFacts,
  hold: HeldTreeHoldKind,
  liveHolder: { number: number; job: string } | null,
) {
  const holderInFlight = heldTreeLiveHolderInFlight({
    hold,
    readerClone: isReadOnlyRepositoryJob(run.job),
    liveHolder,
  })
  if (holderInFlight) return holderInFlight
  if (hold === 'close-out-lease') return null
  const base = {
    treePath: worktree,
    project: run.repo,
    branch: run.branch,
    cursor: cursorFacts(lookupCursor(run, worktree)),
    hold,
  }
  // Cleanliness is measured once here and reused below: `pullRequestLookupNeeded` says whether a
  // pull request can change this hold's verdict, and the same measurement is the uniqueness fact.
  const treeClean = treeIsClean(worktree)
  // A landing-progress hold is in flight already, so only the ref the line prints is at stake, and
  // a cursor that matched this tree supplies it without a pull-request lookup.
  if (hold === 'landing-progress') {
    const matched = heldTreeInFlight({ ...base, openPr: null, treeClean, treeHead: null })
    if (matched) return matched
  }
  // A hold whose verdict the pull request cannot change annotates only from a cursor already
  // matched to this tree: the lookup is skipped rather than made and discarded.
  if (!pullRequestLookupNeeded(hold, treeClean)) {
    return heldTreeInFlight({ ...base, openPr: null, treeClean, treeHead: null })
  }
  const openPr = run.branch ? lookupOpenPr(worktree, run.branch) : null
  const compareHead = hold !== 'landing-progress' && treeClean && Boolean(openPr?.headOid)
  return heldTreeInFlight({
    ...base,
    openPr,
    treeClean: compareHead ? treeClean : false,
    treeHead: compareHead ? treeHead(worktree) : null,
  })
}

export function annotateHeldLandingInFlight(result: CloseOutReportResult): CloseOutReportResult {
  if ((result.reportOutcome ?? result.outcome) !== 'held' || !result.worktree) return result
  if (hasHeldInFlightAnnotation(result)) return result
  const run = lookupRun(result.runId)
  if (!run) return result
  const holder =
    result.leaseHolder ??
    (result.hold === 'close-out-lease' ? { number: run.number, job: run.job } : null)
  const inFlight = inFlightForHold(result.worktree, run, result.hold ?? 'other', holder)
  const detail = annotateHeldTreeDetail(result.detail, inFlight)
  return {
    ...result,
    detail,
    inFlightRef: inFlight?.ref ?? null,
    suppressBlock: inFlight?.suppressBlock ?? false,
  }
}
