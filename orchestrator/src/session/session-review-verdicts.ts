// concern: session review verdict gathering
/** Resolves review-funnel verdicts claimed by this session's open keyed cursors. */

import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { startBoundedSync } from '../../../shared/bounded-process.ts'
import { readMergedBranchLandingTip } from '../branch/branch-landing-records.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { job } from '../jobs/jobs.ts'
import { projectByName } from '../project/projects.ts'
import { resolveReviewBase } from '../review/review-target.ts'
import { reviewFunnelVerdictForChange } from '../review-funnel/review-funnel-verdict-service.ts'
import type { WorkflowCursorListRow } from '../workflow/workflow-cursor-list.ts'
import {
  type StopSummaryReviewVerdictFact,
  stopSummaryReviewVerdictLines,
} from './stop-summary-review-verdict.ts'

type InFlightBranch = {
  project: string
  branch: string
  taskKey: string | null
  worktree: string | null
}

type RootRunBranchRow = Omit<InFlightBranch, 'taskKey'> & {
  taskKey: string
  job: string
}

export type SessionReviewVerdictGatherer = (
  branch: InFlightBranch,
  database: Database,
) => StopSummaryReviewVerdictFact | null | Promise<StopSummaryReviewVerdictFact | null>

type LandedBranchIdentity = {
  head: string | null
  headIsAncestorOfTip: boolean
}

export type SessionReviewBranchLandingIdentity = (
  branch: InFlightBranch,
  tip: string,
  database: Database,
) => LandedBranchIdentity

export function landedBranchOwesNoReviewLine(identity: {
  head: string | null
  tip: string
  headIsAncestorOfTip: boolean
}): boolean {
  return identity.head === null || identity.head === identity.tip || identity.headIsAncestorOfTip
}

function cursorBranch(
  cursor: WorkflowCursorListRow,
  runBranches: ReadonlyMap<string, RootRunBranchRow>,
): InFlightBranch | null {
  const taskKey = cursor.workflow_key?.trim()
  if (!taskKey) return null
  const args = JSON.parse(cursor.args) as Record<string, unknown>
  const explicitBranch = typeof args.branch === 'string' ? args.branch.trim() : ''
  const runBranch = runBranches.get(`${cursor.project}\0${taskKey}`)
  const branch = explicitBranch || runBranch?.branch || ''
  if (!branch) return null
  const explicitWorktree = typeof args.worktree === 'string' ? args.worktree.trim() : ''
  return {
    project: cursor.project,
    branch,
    taskKey,
    worktree: explicitBranch ? explicitWorktree || null : (runBranch?.worktree ?? null),
  }
}

/** Open keyed workflow cursors claim the branch whose review verdict belongs to this session. */
function sessionInFlightReviewBranches(
  session: string,
  cursors: readonly WorkflowCursorListRow[],
  database: Database,
): InFlightBranch[] {
  const runs = database
    .query<RootRunBranchRow, [string]>(
      `SELECT project.name project,run.branch,run.launch_key taskKey,run.worktree,run.job
         FROM run JOIN project ON project.record_id=run.project_record_id
        WHERE run.session_id=? AND run.parent_run_record_id IS NULL AND run.branch IS NOT NULL
          AND run.launch_key IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM run chain_turn
             WHERE (chain_turn.record_id=run.record_id OR chain_turn.parent_run_record_id=run.record_id)
               AND chain_turn.failure_kind='abandoned'
          )
          AND NOT EXISTS (
            SELECT 1 FROM branch_landing_record landed
             WHERE landed.project_record_id=run.project_record_id AND landed.branch=run.branch
               AND landed.merged_at IS NOT NULL
          )
        ORDER BY run.number DESC`,
    )
    .all(session)
  const runBranches = new Map<string, RootRunBranchRow>()
  for (const run of runs) {
    let writesRepo = false
    try {
      writesRepo = Boolean(job(run.job).needs.writesRepo)
    } catch {
      // Unknown jobs cannot establish ownership of a repository branch.
    }
    const identity = `${run.project}\0${run.taskKey}`
    if (writesRepo && !runBranches.has(identity)) runBranches.set(identity, run)
  }
  const branches = new Map<string, InFlightBranch>()
  for (const branch of cursors
    .map((cursor) => cursorBranch(cursor, runBranches))
    .filter((item): item is InFlightBranch => item !== null)) {
    const identity = `${branch.project}\0${branch.branch}`
    const existing = branches.get(identity)
    if (!existing) branches.set(identity, branch)
    else
      branches.set(identity, {
        ...existing,
        taskKey: existing.taskKey ?? branch.taskKey,
      })
  }
  return [...branches.values()]
}

function registeredBranchProject(branch: InFlightBranch, database: Database) {
  const project = projectByName(branch.project, database)
  if (!project) throw new Error(`project ${branch.project} is not registered`)
  return project
}

function branchLandingIdentity(
  branch: InFlightBranch,
  tip: string,
  database: Database,
): LandedBranchIdentity {
  const project = registeredBranchProject(branch, database)
  const cwd = branch.worktree && existsSync(branch.worktree) ? branch.worktree : project.path
  const headResult = startBoundedSync(
    ['git', 'rev-parse', '--verify', '--quiet', `${branch.branch}^{commit}`],
    {
      budget: 'git-plumbing',
      cwd,
      env: targetGitEnvironment(cwd),
    },
  )
  if (headResult.exitCode === 1) return { head: null, headIsAncestorOfTip: false }
  if (headResult.exitCode !== 0) {
    throw new Error(headResult.stderr.trim() || `git could not resolve branch ${branch.branch}`)
  }
  const head = headResult.stdout.toString().trim()
  if (head === tip) return { head, headIsAncestorOfTip: false }
  const ancestorResult = startBoundedSync(['git', 'merge-base', '--is-ancestor', head, tip], {
    budget: 'git-plumbing',
    cwd,
    env: targetGitEnvironment(cwd),
  })
  if (ancestorResult.exitCode === 0) return { head, headIsAncestorOfTip: true }
  if (ancestorResult.exitCode === 1) return { head, headIsAncestorOfTip: false }
  throw new Error(
    ancestorResult.stderr.trim() || `git could not compare branch ${branch.branch} with ${tip}`,
  )
}

async function gatherBranchReviewVerdict(
  branch: InFlightBranch,
  database: Database,
): Promise<StopSummaryReviewVerdictFact | null> {
  try {
    const project = registeredBranchProject(branch, database)
    const trunk = project.settings.trunk?.trim()
    if (!trunk) throw new Error(`project ${branch.project} has no trunk configured`)
    const cwd = branch.worktree && existsSync(branch.worktree) ? branch.worktree : project.path
    const head = startBoundedSync(['git', 'rev-parse', '--verify', `${branch.branch}^{commit}`], {
      budget: 'git-plumbing',
      cwd,
      env: targetGitEnvironment(cwd),
    })
    if (head.exitCode !== 0) {
      throw new Error(
        head.stderr.toString().trim() || `git could not resolve branch ${branch.branch}`,
      )
    }
    const headCommit = head.stdout.toString().trim()
    const base = resolveReviewBase(cwd, headCommit, trunk)
    if (!base) throw new Error(`cannot find merge-base with trunk ${trunk}`)
    const result = await reviewFunnelVerdictForChange({
      database,
      cwd,
      base,
      head: headCommit,
      branch: branch.branch,
      project,
    })
    if (result.kind === 'empty') return null
    return { branch: branch.branch, taskKey: branch.taskKey, verdict: result.verdict }
  } catch (cause) {
    return { branch: branch.branch, taskKey: branch.taskKey, failure: String(cause) }
  }
}

export async function sessionReviewVerdictLines(
  session: string,
  cursors: readonly WorkflowCursorListRow[],
  database: Database,
  options: {
    gather?: SessionReviewVerdictGatherer
    landingIdentity?: SessionReviewBranchLandingIdentity
  } = {},
): Promise<string[]> {
  const gather = options.gather ?? gatherBranchReviewVerdict
  const landingIdentity = options.landingIdentity ?? branchLandingIdentity
  const facts: StopSummaryReviewVerdictFact[] = []
  for (const branch of sessionInFlightReviewBranches(session, cursors, database)) {
    const landedTip = readMergedBranchLandingTip(database, branch.project, branch.branch)
    if (landedTip !== null) {
      try {
        if (
          landedBranchOwesNoReviewLine({
            ...landingIdentity(branch, landedTip, database),
            tip: landedTip,
          })
        )
          continue
      } catch {
        // Gathering owns the user-visible remedy when the git comparison fails.
      }
    }
    const fact = await gather(branch, database)
    if (fact !== null) facts.push(fact)
  }
  return stopSummaryReviewVerdictLines(facts)
}
