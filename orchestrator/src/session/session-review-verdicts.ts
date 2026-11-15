// concern: session review verdict gathering
/** Resolves review-funnel verdicts for the branches still in flight for one session. */

import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { startBoundedSync } from '../../../shared/bounded-process.ts'
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
  claimedByCursor: boolean
}

type RootRunBranchRow = Omit<InFlightBranch, 'claimedByCursor'> & { job: string }

export type SessionReviewVerdictGatherer = (
  branch: InFlightBranch,
  database: Database,
) => StopSummaryReviewVerdictFact

export type SessionReviewBranchRefExists = (branch: InFlightBranch, database: Database) => boolean

function cursorBranch(cursor: WorkflowCursorListRow): InFlightBranch | null {
  if (cursor.workflow_slug !== 'ship-task') return null
  const args = JSON.parse(cursor.args) as Record<string, unknown>
  const branch = typeof args.branch === 'string' ? args.branch.trim() : ''
  if (!branch) return null
  const worktree = typeof args.worktree === 'string' ? args.worktree.trim() : ''
  return {
    project: cursor.project,
    branch,
    taskKey: cursor.workflow_key?.trim() || null,
    worktree: worktree || null,
    claimedByCursor: true,
  }
}

/** The ruled branch set: open ship cursors plus unmerged, unabandoned root writing runs. */
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
          AND COALESCE(run.failure_kind,'') <> 'abandoned'
          AND NOT EXISTS (
            SELECT 1 FROM branch_landing_record landed
             WHERE landed.project_record_id=run.project_record_id AND landed.branch=run.branch
               AND landed.merged_at IS NOT NULL
          )
        ORDER BY run.number`,
    )
    .all(session)
    .filter((run) => {
      try {
        return job(run.job).needs.writesRepo
      } catch {
        return false
      }
    })
  const branches = new Map<string, InFlightBranch>()
  for (const branch of [
    ...cursors.map(cursorBranch).filter((item): item is InFlightBranch => item !== null),
    ...runs.map((run) => ({ ...run, claimedByCursor: false })),
  ]) {
    const identity = `${branch.project}\0${branch.branch}`
    const existing = branches.get(identity)
    if (!existing) branches.set(identity, branch)
    else
      branches.set(identity, {
        ...existing,
        taskKey: existing.taskKey ?? branch.taskKey,
        claimedByCursor: existing.claimedByCursor || branch.claimedByCursor,
      })
  }
  return [...branches.values()]
}

function branchRefExistsInMainCheckout(branch: InFlightBranch, database: Database): boolean {
  const project = projectByName(branch.project, database)
  if (!project) throw new Error(`project ${branch.project} is not registered`)
  const result = startBoundedSync(
    ['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch.branch}`],
    {
      budget: 'git-plumbing',
      cwd: project.path,
      env: targetGitEnvironment(project.path),
    },
  )
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  throw new Error(
    result.stderr.trim() || `git could not check branch ${branch.branch} in ${project.path}`,
  )
}

function gatherBranchReviewVerdict(
  branch: InFlightBranch,
  database: Database,
): StopSummaryReviewVerdictFact {
  try {
    const project = projectByName(branch.project, database)
    if (!project) throw new Error(`project ${branch.project} is not registered`)
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
    const { verdict } = reviewFunnelVerdictForChange({
      database,
      cwd,
      base,
      head: headCommit,
      branch: branch.branch,
      project,
    })
    return { branch: branch.branch, taskKey: branch.taskKey, verdict }
  } catch (cause) {
    return { branch: branch.branch, taskKey: branch.taskKey, failure: String(cause) }
  }
}

export function sessionReviewVerdictLines(
  session: string,
  cursors: readonly WorkflowCursorListRow[],
  database: Database,
  gather: SessionReviewVerdictGatherer = gatherBranchReviewVerdict,
  refExists: SessionReviewBranchRefExists = branchRefExistsInMainCheckout,
): string[] {
  return stopSummaryReviewVerdictLines(
    sessionInFlightReviewBranches(session, cursors, database).flatMap((branch) => {
      if (!branch.claimedByCursor) {
        try {
          if (!refExists(branch, database)) return []
        } catch (cause) {
          return [
            {
              branch: branch.branch,
              taskKey: branch.taskKey,
              failure: String(cause),
            },
          ]
        }
      }
      return [gather(branch, database)]
    }),
  )
}
