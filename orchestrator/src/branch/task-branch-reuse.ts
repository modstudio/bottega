// concern: task-branch-reuse
/**
 * Knows whether a fresh writer may reuse a resolved task branch. Must not know
 * run claims, worktree creation, transports, or contracts.
 */

import { targetGitEnvironment } from '../git/git-environment.ts'
import { resolveTaskBranch, type TaskBranchCandidate, taskBranchIsAncestor } from './task-branch.ts'

export type TaskBranchSessionReuseDecision = { action: 'reuse' } | { action: 'refuse' }

/** Decide whether a candidate has a nominating run owned by the dispatching session. */
export function decideTaskBranchSessionReuse(
  dispatchingSession: string | null,
  nominatingRunSessions: readonly (string | null)[],
): TaskBranchSessionReuseDecision {
  return dispatchingSession !== null && nominatingRunSessions.includes(dispatchingSession)
    ? { action: 'reuse' }
    : { action: 'refuse' }
}

/** Compose the refusal for implicit reuse across a session boundary. */
export function taskBranchSessionRefusal(candidate: TaskBranchCandidate): string {
  const owners = new Map<string, number[]>()
  for (const run of candidate.nominatingRuns) {
    const owner = run.sessionId ?? 'no session'
    owners.set(owner, [...(owners.get(owner) ?? []), run.id])
  }
  const ownership = [...owners].map(([owner, ids]) => `runs ${ids.join(', ')}: ${owner}`).join('; ')
  return (
    `refusing task branch ${candidate.branch} tip ${candidate.tip}: ` +
    `nominating run ownership (${ownership}) does not include the dispatching session.\n` +
    `cleared by: repeat the dispatch with --base ${candidate.trunk} to start a fresh branch, ` +
    `or --base ${candidate.branch} to build on it deliberately`
  )
}

/** Refuse cross-session implicit reuse, or pass through the candidate unchanged. */
export function taskBranchForDispatchingSession(
  candidate: TaskBranchCandidate,
  dispatchingSession: string | null,
): TaskBranchCandidate {
  const decision = decideTaskBranchSessionReuse(
    dispatchingSession,
    candidate.nominatingRuns.map((run) => run.sessionId),
  )
  if (decision.action === 'refuse') throw new Error(taskBranchSessionRefusal(candidate))
  return candidate
}

export type TaskBranchReuseFacts = {
  callerOnTrunk: boolean
  candidateIsAncestorOfCaller: boolean
  callerIsAncestorOfCandidate: boolean
  callerBranch: string | null
  callerHead: string
  candidateBranch: string
  candidateTip: string
}

export type TaskBranchReuseDecision =
  | { action: 'reuse' }
  | { action: 'fresh' }
  | {
      action: 'refuse'
      callerBranch: string | null
      callerHead: string
      candidateBranch: string
      candidateTip: string
    }

/** Decide reuse from branch identity and ancestry facts, without observing Git. */
export function decideTaskBranchReuse(facts: TaskBranchReuseFacts): TaskBranchReuseDecision {
  if (facts.callerOnTrunk) return { action: 'reuse' }
  if (facts.candidateIsAncestorOfCaller) return { action: 'fresh' }
  if (facts.callerIsAncestorOfCandidate) return { action: 'reuse' }
  return {
    action: 'refuse',
    callerBranch: facts.callerBranch,
    callerHead: facts.callerHead,
    candidateBranch: facts.candidateBranch,
    candidateTip: facts.candidateTip,
  }
}

export function taskBranchDivergenceRefusal(
  refusal: Extract<TaskBranchReuseDecision, { action: 'refuse' }>,
): string {
  const callerName = refusal.callerBranch ?? 'detached HEAD'
  const base = refusal.callerBranch ?? refusal.callerHead
  return (
    `refusing task branch ${refusal.candidateBranch} tip ${refusal.candidateTip}: ` +
    `caller ${callerName} HEAD ${refusal.callerHead} and the task branch have diverged.\n` +
    `invariant: A fresh keyed writer must not replace the caller's HEAD with an incompatible task branch.\n` +
    `cleared by: repeat the dispatch with --base ${base} to start fresh from the caller, ` +
    `or bring ${callerName} forward to include ${refusal.candidateBranch}`
  )
}

function taskBranchGit(cwd: string, args: string[], allowExitOne = false): string | null {
  const process = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (allowExitOne && process.exitCode === 1) return null
  if (process.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed while checking task branch compatibility: ` +
        (process.stderr.toString().trim() || `exit ${process.exitCode}`),
    )
  }
  return process.stdout.toString().trim()
}

/** Gather the caller's Git facts once and apply the pure reuse decision. */
function compatibleTaskBranch(
  cwd: string,
  candidate: TaskBranchCandidate,
): TaskBranchCandidate | null {
  const callerHead = taskBranchGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])!
  const callerBranch = taskBranchGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)
  const decision = decideTaskBranchReuse({
    callerOnTrunk: callerBranch === candidate.trunk,
    candidateIsAncestorOfCaller: taskBranchIsAncestor(cwd, candidate.tip, callerHead),
    callerIsAncestorOfCandidate: taskBranchIsAncestor(cwd, callerHead, candidate.tip),
    callerBranch,
    callerHead,
    candidateBranch: candidate.branch,
    candidateTip: candidate.tip,
  })
  if (decision.action === 'refuse') throw new Error(taskBranchDivergenceRefusal(decision))
  return decision.action === 'reuse' ? candidate : null
}

/** Resolve and compatibility-check the candidate used by a fresh keyed writer. */
export function resolveCompatibleTaskBranch(
  cwd: string,
  launchKey: string,
  dispatchingSession: string | null,
): TaskBranchCandidate | null {
  const candidate = resolveTaskBranch(cwd, launchKey)
  if (!candidate) return null
  return compatibleTaskBranch(cwd, taskBranchForDispatchingSession(candidate, dispatchingSession))
}
