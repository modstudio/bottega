// concern: worktree-caller
import { cpSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { projectAt } from './projects.ts'
import { git, gitBytes, gitInput, gitOk, repoRootOf } from './git-environment.ts'
import type { Worktree } from './worktree-types.ts'

export function resolveBase(cwd: string, ref: string): string {
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)
  return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], repoRoot)
}

/** Resolve a read-only snapshot against the checkout the operator invoked. */
export function resolveReadOnlyBase(cwd: string, ref: string): string {
  return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], cwd)
}

export type CarriedWorkingState = {
  /** The commit the tracked patch was computed against. */
  base: string
  /** Paths represented by the git patch applied to the new tree. */
  tracked: string[]
  /** Non-ignored untracked paths copied outside the patch. */
  untracked: string[]
}

/**
 * Refuse a caller whose HEAD does not descend from the tree's base.
 *
 * Orthogonal to whether carrying was requested. A behind-or-diverged caller
 * applying a patch would revert the tree; opting in does not license that, and
 * opting out does not skip the check.
 */
export function assertCallerAncestry(cwd: string, worktree: Worktree): void {
  const callerHead = git(['rev-parse', 'HEAD'], cwd)
  if (gitOk(['merge-base', '--is-ancestor', worktree.base, callerHead], cwd) === null) {
    throw new Error(
      `caller HEAD ${callerHead} is behind or diverged from the tree's base ${worktree.base}; ` +
        `update the caller checkout so its HEAD descends from the tree's base, then retry\n` +
        `invariant: A resume is always possible on a stale checkout.\n` +
        `cleared by: git merge --ff-only ${worktree.base}`,
    )
  }
}

export type CallerDrift = { callerHead: string; base: string; baseRef: string }

/**
 * Detect the ancestry mismatch before a repository run is dispatched.
 *
 * Project-owned worktree creation may choose a fresher floor than the caller's
 * checkout. For a recipe that floor is declared directly. A command-based tool
 * owns the choice, so its best pre-creation proxy is the registered trunk's
 * upstream: that is the ref fetch advances while leaving the caller behind.
 * Plain git worktrees need no preview because their default floor is HEAD.
 */
export function callerDrift(cwd: string, baseRef?: string): CallerDrift | null {
  const project = projectAt(cwd)
  const tool = project?.settings.worktree
  if (!project || !tool) return null

  let ref = baseRef
  if (!ref && tool.recipe?.baseRef) ref = tool.recipe.baseRef
  if (!ref && tool.create) {
    const trunk = project.settings.trunk ?? gitOk(['symbolic-ref', '--short', 'HEAD'], project.path)
    if (!trunk) return null
    ref =
      gitOk(['rev-parse', '--abbrev-ref', `${trunk}@{upstream}`], project.path) ?? `origin/${trunk}`
  }
  if (!ref) return null

  const base = gitOk(['rev-parse', '--verify', ref], project.path)
  const callerHead = gitOk(['rev-parse', 'HEAD'], cwd)
  if (!base || !callerHead) return null
  if (gitOk(['merge-base', '--is-ancestor', base, callerHead], cwd) !== null) return null
  return { callerHead, base, baseRef: ref }
}

/** Non-ignored uncommitted paths, including untracked files. False if git cannot answer. */
export function checkoutHasUncommittedWork(cwd: string): boolean {
  return Boolean(gitOk(['status', '--porcelain', '--untracked-files=all'], cwd))
}

export function carryWorkingState(cwd: string, worktree: Worktree): CarriedWorkingState {
  assertCallerAncestry(cwd, worktree)

  const patch = gitBytes(['diff', '--binary', '--full-index', worktree.base, '--'], cwd)
  const tracked = gitBytes(['diff', '--name-only', '-z', worktree.base, '--'], cwd)
    .toString()
    .split('\0')
    .filter(Boolean)
  if (patch.byteLength)
    gitInput(['apply', '--binary', '--whitespace=nowarn', '-'], worktree.path, patch)

  const untracked = gitBytes(['ls-files', '--others', '--exclude-standard', '-z'], cwd)
    .toString()
    .split('\0')
    .filter(Boolean)
  const otherWorktrees = (gitOk(['worktree', 'list', '--porcelain'], cwd) ?? '')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => realpathSync(line.slice('worktree '.length)))
    .filter((path) => path !== realpathSync(cwd))
  const copied: string[] = []
  for (const relative of untracked) {
    const source = join(cwd, relative)
    const absoluteSource = realpathSync(source)
    if (
      otherWorktrees.some(
        (path) => absoluteSource === path || path.startsWith(`${absoluteSource}/`),
      )
    ) {
      continue
    }
    const destination = join(worktree.path, relative)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, { recursive: true, force: true, verbatimSymlinks: true })
    copied.push(relative)
  }
  return { base: worktree.base, tracked, untracked: copied }
}

/**
 * Build a worktree from a declaration, doing what a project's script would.
 *
 * Torn down on ANY failure, and that is not tidiness. A half-provisioned tree —
 * dependencies installed, database missing — is the single worst outcome here:
 * a worker runs the suite in it, the suite passes against nothing, and the run
 * comes back green. Better no worktree and a named failure.
 */
