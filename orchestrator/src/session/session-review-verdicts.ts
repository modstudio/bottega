// concern: session review verdict gathering
/** Resolves review-funnel verdicts for the branches still in flight for one session. */

import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { startBoundedSync } from '../../../shared/bounded-process.ts'
import { readMergedBranchLandingTip } from '../branch/branch-landing-records.ts'
import { resolveTaskBranch } from '../branch/task-branch.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
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
  resolutionFailure?: string
}

export type SessionReviewVerdictGatherer = (
  branch: InFlightBranch,
  database: Database,
) => StopSummaryReviewVerdictFact | null

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

export type SessionReviewTaskBranchResolver = (
  cwd: string,
  key: string,
) => { branch: string } | null

function cursorBranch(
  cursor: WorkflowCursorListRow,
  database: Database,
  resolve: SessionReviewTaskBranchResolver,
): InFlightBranch | null {
  const taskKey = cursor.workflow_key?.trim()
  if (!taskKey) return null
  const args = JSON.parse(cursor.args) as Record<string, unknown>
  let branch = typeof args.branch === 'string' ? args.branch.trim() : ''
  const worktree = typeof args.worktree === 'string' ? args.worktree.trim() : ''
  let resolutionFailure: string | undefined
  if (!branch) {
    try {
      const project = projectByName(cursor.project, database)
      if (!project) throw new Error(`project ${cursor.project} is not registered`)
      branch = resolve(project.path, taskKey)?.branch ?? ''
    } catch (cause) {
      branch = taskKey
      resolutionFailure = String(cause)
    }
  }
  if (!branch) return null
  return {
    project: cursor.project,
    branch,
    taskKey,
    worktree: worktree || null,
    resolutionFailure,
  }
}

/** Open keyed workflow cursors claim the branch whose review verdict belongs to this session. */
function sessionInFlightReviewBranches(
  cursors: readonly WorkflowCursorListRow[],
  database: Database,
  resolve: SessionReviewTaskBranchResolver,
): InFlightBranch[] {
  const branches = new Map<string, InFlightBranch>()
  for (const branch of cursors
    .map((cursor) => cursorBranch(cursor, database, resolve))
    .filter((item): item is InFlightBranch => item !== null)) {
    const identity = `${branch.project}\0${branch.branch}`
    const existing = branches.get(identity)
    if (!existing) branches.set(identity, branch)
    else
      branches.set(identity, {
        ...existing,
        taskKey: existing.taskKey ?? branch.taskKey,
        resolutionFailure: existing.resolutionFailure ?? branch.resolutionFailure,
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

function gatherBranchReviewVerdict(
  branch: InFlightBranch,
  database: Database,
): StopSummaryReviewVerdictFact | null {
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
    const result = reviewFunnelVerdictForChange({
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

export function sessionReviewVerdictLines(
  _session: string,
  cursors: readonly WorkflowCursorListRow[],
  database: Database,
  gather: SessionReviewVerdictGatherer = gatherBranchReviewVerdict,
  landingIdentity: SessionReviewBranchLandingIdentity = branchLandingIdentity,
  resolve: SessionReviewTaskBranchResolver = resolveTaskBranch,
): string[] {
  return stopSummaryReviewVerdictLines(
    sessionInFlightReviewBranches(cursors, database, resolve).flatMap((branch) => {
      if (branch.resolutionFailure) {
        return [
          {
            branch: branch.branch,
            taskKey: branch.taskKey,
            failure: branch.resolutionFailure,
          },
        ]
      }
      const landedTip = readMergedBranchLandingTip(database, branch.project, branch.branch)
      if (landedTip !== null) {
        try {
          if (
            landedBranchOwesNoReviewLine({
              ...landingIdentity(branch, landedTip, database),
              tip: landedTip,
            })
          )
            return []
        } catch {
          // Gathering owns the user-visible remedy when the git comparison fails.
        }
      }
      const fact = gather(branch, database)
      return fact === null ? [] : [fact]
    }),
  )
}
