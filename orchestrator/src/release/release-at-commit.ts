// concern: lifecycle-backed release checkout
/** Provisions, deploys from, and releases one checkout at an exact commit. */

import { randomUUID } from 'node:crypto'
import { git, gitResult, targetGitEnvironment } from '../git/git-environment.ts'
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
  ensureCommit(project: Project, commit: string): void
  deploy(target: CheckoutReleaseTarget, path: string, commit: string): ReleaseResult
  id(): string
  now(): number
}

type EnsureCommitGitRunner = {
  check(args: string[], cwd: string, env: NodeJS.ProcessEnv): { ok: boolean; stderr: string }
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
  check: (args, cwd, env) => gitResult(args, cwd, { env }),
  fetch: (args, cwd, env) => {
    git(args, cwd, env)
  },
}

export function ensureCommitWithGit(
  project: Project,
  commit: string,
  runner: EnsureCommitGitRunner,
): void {
  const cwd = project.path
  const env = targetGitEnvironment(cwd)
  const checkArgs = ['cat-file', '-e', `${commit}^{commit}`]
  if (runner.check(checkArgs, cwd, env).ok) return

  const trunk = project.settings.trunk
  if (!trunk) throw new Error('project has no trunk; set trunk, then retry')

  const fetchArgs = ['fetch', 'origin', trunk]
  const remedy = `git -C ${cwd} fetch origin ${trunk}, then rerun`
  try {
    runner.fetch(fetchArgs, cwd, env)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `commit ${commit} is absent from checkout ${cwd}; fetch failed: ${detail}; run ${remedy}`,
    )
  }

  if (!runner.check(checkArgs, cwd, env).ok) {
    throw new Error(
      `commit ${commit} is not on origin's ${trunk} after fetching in checkout ${cwd}; run ${remedy}`,
    )
  }
}

function ensureCommit(project: Project, commit: string): void {
  ensureCommitWithGit(project, commit, ensureCommitGitRunner)
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
  dependencies.ensureCommit(target.project, input.commit)
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
