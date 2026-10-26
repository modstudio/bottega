// concern: workflow compose branch
/** Decides whether a workflow that lands a built branch was given one. Must not know CLI grammar, commands, or transports. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { gitContext, observeGitRef } from '../git/git-environment.ts'
import { projectByName } from '../project/projects.ts'

/** Workflows that land a branch an implementation run built, so an empty branch is not their work. */
const LANDS_A_BUILT_BRANCH = new Set(['ship-task'])

export type LandingBranchFacts = {
  workflow: string
  branch: string
  landingBranch: string
  /** Commits on the branch that the landing branch does not have; null when that could not be read. */
  commitsPastLanding: number | null
}

/**
 * The refusal a landing workflow owes a branch with nothing on it.
 *
 * A branch the landing branch already contains carries no change, so there is nothing to review,
 * gate or land; the workflow that lands built branches says so instead of walking its steps.
 */
export function landingBranchRefusal(facts: LandingBranchFacts): string | null {
  if (!LANDS_A_BUILT_BRANCH.has(facts.workflow)) return null
  if (facts.commitsPastLanding !== 0) return null
  return (
    `refusing to compose ${facts.workflow} for branch ${facts.branch}: it has no commits past ` +
    `${facts.landingBranch}, and ${facts.workflow} lands a built branch; build the change first ` +
    `with \`${PLATFORM_SLUG} run start implement --key <key>\``
  )
}

/**
 * Commits a branch carries past the landing branch, or null when no checkout can answer.
 *
 * Injected so a caller can prove the refusal without a repository; `readCommitsPastLanding` is the
 * default.
 */
export type CommitCountPort = (
  checkout: string,
  branch: string,
  landingBranch: string,
) => number | null

/** The world a landing-branch refusal reads through; every port defaults to the real one. */
export type LandingBranchPorts = { commitCount?: CommitCountPort }

/**
 * Commits the landing branch does not have, or null when no checkout can answer.
 *
 * The remote-tracking ref is the landing branch's current tip; a checkout that has only the local
 * branch answers against the local one, which reports the same empty branch and errs toward
 * answering. A missing branch, an unread checkout and a missing ref all answer null.
 */
export const readCommitsPastLanding: CommitCountPort = (
  checkout: string,
  branch: string,
  landingBranch: string,
): number | null => {
  const upstream = `origin/${landingBranch}`
  const landingRef =
    observeGitRef(checkout, upstream).outcome === 'present'
      ? upstream
      : observeGitRef(checkout, landingBranch).outcome === 'present'
        ? landingBranch
        : null
  if (!landingRef) return null
  const counted = gitContext(checkout, 'rev-list', '--count', branch, '--not', landingRef)
  const count = Number(counted)
  return counted === null || !Number.isSafeInteger(count) || count < 0 ? null : count
}

/**
 * Refuse a composition of a landing workflow whose named branch has nothing past the landing
 * branch, reading the project's registered checkout and the branch's own worktree.
 */
export function workflowComposeBranchRefusal(input: {
  workflow: string
  project: string
  args: Record<string, string>
  d?: Database
  commitCount?: CommitCountPort
}): string | null {
  if (!LANDS_A_BUILT_BRANCH.has(input.workflow)) return null
  const branch = input.args.branch?.trim()
  if (!branch) return null
  const registered = projectByName(input.project, input.d ?? db())
  if (!registered) return null
  const landingBranch = registered.settings.trunk?.trim()
  if (!landingBranch) return null
  const commitCount = input.commitCount ?? readCommitsPastLanding
  for (const checkout of [input.args.worktree?.trim(), registered.path]) {
    if (!checkout) continue
    const facts = {
      workflow: input.workflow,
      branch,
      landingBranch,
      commitsPastLanding: commitCount(checkout, branch, landingBranch),
    }
    const refusal = landingBranchRefusal(facts)
    if (refusal) return refusal
    if (facts.commitsPastLanding !== null) return null
  }
  return null
}
