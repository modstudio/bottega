// concern: review-target
/**
 * Knows the project register, worktree base rules, and branch refs. Must not
 * know transports, database write paths, contracts, or routing.
 */
import { basename } from 'node:path'
import { branchOf, gitContext, targetGitEnvironment } from '../git/git-environment.ts'
import { projectAt, resolveBranchRef } from '../project/projects.ts'
import { resolveBase } from '../worktree/worktree-caller.ts'

const EXPLICIT_REVIEW_JOBS = new Set(['review-lens', 'safety', 'craft'])

/** Prefer the last-fetched trunk when it exists; otherwise use the local trunk. */
export function reviewTrunkRef(remoteTrackingRefExists: boolean, trunk: string): string {
  return remoteTrackingRefExists ? `origin/${trunk}` : trunk
}

/** Trunk merge-base of a reviewed commit. Same resolution for --review and implicit lenses. */
function resolveReviewMergeBase(cwd: string, commit: string, trunk: string): string | null {
  const remoteTrackingRefExists =
    gitContext(cwd, 'show-ref', '--verify', `refs/remotes/origin/${trunk}`) !== null
  const trunkCommit = resolveBase(cwd, `${reviewTrunkRef(remoteTrackingRefExists, trunk)}^{commit}`)
  return gitContext(cwd, 'merge-base', commit, trunkCommit)
}

export function emptyReviewRefusal(
  commit: string,
  base: string,
  ref: string,
  trunk: string,
): string | null {
  if (commit !== base) return null
  return (
    `refused: --review ${ref} resolves to ${commit.slice(0, 8)}, which is already on ${trunk}, ` +
    `so there is no change to review. Pass the branch under review (the ref whose commits are not ` +
    `on ${trunk}), not its base.`
  )
}

/** Coverage base for a findings job dispatched without --review. Null if unmeasurable. */
export function implicitReviewCoverageBase(cwd: string): string | null {
  const trunk = projectAt(cwd)?.settings.trunk?.trim()
  if (!trunk) return null
  try {
    const commit = resolveBase(cwd, 'HEAD')
    return resolveReviewMergeBase(cwd, commit, trunk)
  } catch {
    return null
  }
}

export function resolveReviewTarget(
  jobName: string,
  cwd: string,
  reviewRef?: string,
  carry = false,
): { branch: string; commit: string; base: string } | null {
  if (reviewRef === undefined) return null
  if (!EXPLICIT_REVIEW_JOBS.has(jobName)) {
    throw new Error('--review is only valid for review-lens, safety, and craft')
  }
  // Review jobs never write, so their tree is the detached read-only one
  // (readonly_create or plain git), never worktree.create: the writing recipe's
  // placeholders and detached support are irrelevant here.
  const project = projectAt(cwd)
  const { branch } = resolveBranchRef(reviewRef)
  if (carry && branchOf(cwd) !== branch) {
    throw new Error(
      `--review ${reviewRef} resolves to branch ${branch}, but --carry was requested from ` +
        `${branchOf(cwd) ?? '(detached HEAD)'}; run --carry from that branch's own worktree`,
    )
  }
  const trunk = project?.settings.trunk?.trim()
  if (!trunk) {
    throw new Error(
      `project ${project?.name ?? '(unregistered)'} has no trunk configured; ` +
        '--review needs one to measure the reviewed change',
    )
  }
  const commit = resolveBase(cwd, `${branch}^{commit}`)
  const base = resolveReviewMergeBase(cwd, commit, trunk)
  if (!base) {
    throw new Error(`cannot find merge-base between review target ${branch} and trunk ${trunk}`)
  }
  const refusal = emptyReviewRefusal(commit, base, reviewRef, trunk)
  if (refusal) throw new Error(refusal)
  return { branch, commit, base }
}

export function implicitReviewWarning(cwd: string): string {
  const branch = branchOf(cwd) ?? '(detached HEAD)'
  const p = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--verify', 'HEAD^{commit}'], {
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const commit = p.exitCode === 0 ? p.stdout.toString().trim() : null
  return `reviewing ${branch} at ${commit?.slice(0, 8) ?? 'unknown'}; pass --review <branch> to be explicit`
}

/**
 * Find one recorded ticket key in a deliberate context name.
 *
 * A name with no matching key is silent. A name with two is silent too: choosing
 * between two real-looking addresses would be guessing, and a wrong attribution
 * is worse than null. Project prefixes narrow the candidates where the register
 * declares them; the worktree key pattern remains the final validity check.
 */
function keyIn(name: string, cwd: string): string | null {
  const project = projectAt(cwd)
  const prefixes = project?.settings.keyPrefixes
  const prefix = prefixes?.length
    ? `(?:${prefixes.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`
    : '[A-Z][A-Z0-9]+'
  const candidates =
    name
      .match(new RegExp(`(?:^|[^A-Z0-9])(${prefix}-[0-9]+)(?=$|[^A-Z0-9])`, 'g'))
      ?.map((candidate) => candidate.match(new RegExp(`(${prefix}-[0-9]+)`))?.[1])
      .filter((candidate): candidate is string => Boolean(candidate)) ?? []
  const keyPattern = project?.settings.worktree?.keyPattern ?? '^[A-Z][A-Z0-9]+-[0-9]+$'
  const valid = [
    ...new Set(candidates.filter((candidate) => new RegExp(keyPattern).test(candidate))),
  ]
  return valid.length === 1 ? valid[0]! : null
}

/** Attribution for a read-only root: worktree name first, then branch. */
export function inferredReadOnlyKey(cwd: string): string | null {
  const top = gitContext(cwd, 'rev-parse', '--show-toplevel')
  const fromWorktree = top ? keyIn(basename(top), cwd) : null
  return fromWorktree ?? keyIn(branchOf(cwd) ?? '', cwd)
}
