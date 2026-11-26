// concern: lifecycle-backed release checkout
/** Ensures the requested commit is present in the registered checkout, fetching origin's landing branch and rung branch when absent, then provisions, deploys from, and releases one checkout at that commit. */

import { randomUUID } from 'node:crypto'
import { BoundExceededError } from '../../../shared/call-budgets.ts'
import type { GitRefObservation } from '../git/git-environment.ts'
import { git, observeGitRef, targetGitEnvironment } from '../git/git-environment.ts'
import { type Project, resolvedWorktreeTool } from '../project/projects.ts'
import {
  type CheckoutReleaseTarget,
  type ReleaseResult,
  releaseProjectFromCheckout,
  resolveCheckoutReleaseTarget,
} from './release-service.ts'

export type ReleaseAtCommitReport = {
  result: ReleaseResult
  provisionMs: number
  deployMs: number
  releaseMs: number
  residue?: string
}

export type ReleaseAtCommitDependencies = {
  resolve(project: string, rung: string, commit: string): CheckoutReleaseTarget
  ensureCommit(
    project: Pick<Project, 'path' | 'settings'>,
    commit: string,
    rungBranch: string,
  ): void
  deploy(target: CheckoutReleaseTarget, path: string, commit: string): ReleaseResult
  id(): string
  now(): number
}

type EnsureCommitGitRunner = {
  observe(cwd: string, ref: string): GitRefObservation
  fetch(args: string[], cwd: string, env: NodeJS.ProcessEnv): void
}

type ReleaseTreeRemovalResult =
  | { outcome: 'released' | 'absent' }
  | { outcome: 'kept'; reason: string }
  | { outcome: 'failed'; detail: string }

export type ReleaseTreeLifecycle = {
  create(projectPath: string, name: string, commit: string): string
  remove(path: string): Promise<ReleaseTreeRemovalResult>
}

const releaseAtCommitDependencies: ReleaseAtCommitDependencies = {
  resolve: resolveCheckoutReleaseTarget,
  ensureCommit,
  deploy: releaseProjectFromCheckout,
  id: randomUUID,
  now: Date.now,
}

const ensureCommitGitRunner: EnsureCommitGitRunner = {
  observe: observeGitRef,
  fetch: (args, cwd, env) => {
    git(args, cwd, env)
  },
}

function commitIsPresent(
  observation: GitRefObservation,
  commit: string,
  cwd: string,
  afterFetch = false,
): boolean {
  if (observation.outcome === 'present') return true
  if (observation.outcome === 'failed') {
    const phase = afterFetch ? ' after fetching' : ''
    throw new Error(
      `could not verify commit ${commit} in checkout ${cwd}${phase}: ${observation.detail}`,
    )
  }
  return false
}

export function ensureCommitWithGit(
  project: Pick<Project, 'path' | 'settings'>,
  commit: string,
  rungBranch: string,
  runner: EnsureCommitGitRunner,
): void {
  const cwd = project.path
  const env = targetGitEnvironment(cwd)
  const ref = `${commit}^{commit}`
  if (commitIsPresent(runner.observe(cwd, ref), commit, cwd)) return

  const trunk = project.settings.trunk
  if (!trunk) throw new Error('project has no trunk; set trunk, then retry')

  const branches = rungBranch && rungBranch !== trunk ? [trunk, rungBranch] : [trunk]
  const remedy = `git -C ${cwd} fetch origin ${branches.join(' ')}, then rerun`
  for (const branch of branches) {
    try {
      runner.fetch(['fetch', 'origin', branch], cwd, env)
    } catch (cause) {
      if (cause instanceof BoundExceededError) throw cause
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw new Error(
        `commit ${commit} is absent from checkout ${cwd}; fetch of origin's ${branch} failed: ${detail}; run ${remedy}`,
      )
    }
  }

  if (!commitIsPresent(runner.observe(cwd, ref), commit, cwd, true)) {
    throw new Error(
      `commit ${commit} is not on origin's ${branches.join(' or ')} after fetching in checkout ${cwd}; run ${remedy}`,
    )
  }
}

function ensureCommit(
  project: Pick<Project, 'path' | 'settings'>,
  commit: string,
  rungBranch: string,
): void {
  ensureCommitWithGit(project, commit, rungBranch, ensureCommitGitRunner)
}

/** The single capability predicate shared by merge ordering and machine update. */
export function canDeployRungFromReleaseTree(
  project: Pick<Project, 'path' | 'settings'>,
  rung: { deploy?: string },
): boolean {
  return rung.deploy !== undefined && resolvedWorktreeTool(project)?.recipePath !== undefined
}

function removalResidue(result: ReleaseTreeRemovalResult): string | undefined {
  if (result.outcome === 'kept') return result.reason
  if (result.outcome === 'failed') return result.detail
  return undefined
}

export async function releaseAtCommit(input: {
  project: string
  rung: string
  commit: string
  lifecycle: ReleaseTreeLifecycle
  dependencies?: ReleaseAtCommitDependencies
}): Promise<ReleaseAtCommitReport> {
  const dependencies = input.dependencies ?? releaseAtCommitDependencies
  const target = dependencies.resolve(input.project, input.rung, input.commit)
  const provisionStarted = dependencies.now()
  const treeName = `release-${input.rung}-${dependencies.id()}`
  dependencies.ensureCommit(target.project, input.commit, target.selected.branch)
  const path = input.lifecycle.create(target.project.path, treeName, input.commit)
  const provisionMs = dependencies.now() - provisionStarted
  let result: ReleaseResult | undefined
  let failure: unknown
  const deployStarted = dependencies.now()
  try {
    result = dependencies.deploy(target, path, input.commit)
  } catch (cause) {
    failure = cause
  }
  const deployMs = dependencies.now() - deployStarted
  const releaseStarted = dependencies.now()
  let residue: string | undefined
  try {
    residue = removalResidue(await input.lifecycle.remove(path))
  } catch (cause) {
    residue = cause instanceof Error ? cause.message : String(cause)
  }
  const releaseMs = dependencies.now() - releaseStarted
  if (failure) {
    if (!residue) throw failure
    const detail = failure instanceof Error ? failure.message : String(failure)
    throw new Error(`${detail}; release checkout residue: ${residue}`)
  }
  return { result: result!, provisionMs, deployMs, releaseMs, ...(residue ? { residue } : {}) }
}
