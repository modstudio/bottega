// concern: pure broad-area read policy; must not know sandbox-runtime or secret paths.

import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  resolveHubDatabase,
  resolveOrchestratorDatabase,
  resolveRunsDirectory,
  resolveStatePaths,
  type StateEnvironment,
} from '../../../shared/state-directory.ts'
import type { Project } from '../project/projects.ts'
import { mainCheckoutWorktreeHint } from '../project/projects.ts'
import { runHarnessStateDir } from '../run-owned-paths.ts'

export type AreaReadPolicy = { deny: string[]; allow: string[] }

export type WorktreeDenyForm = 'live-glob' | 'launch-literal'

export const isAtOrBelow = (path: string, parent: string) => {
  const fromParent = relative(parent, path)
  return fromParent === '' || (!fromParent.startsWith('..') && !isAbsolute(fromParent))
}

/** A carve-back may never reopen a protected path or one of its parents. */
export function carveBackOutsideProtected(
  allowed: string,
  protectedDenies: readonly string[],
): boolean {
  return !protectedDenies.some(
    (denied) => isAtOrBelow(allowed, denied) || isAtOrBelow(denied, allowed),
  )
}

/**
 * Hide sibling worktrees without placing a literal deny above the run's own tree.
 * macOS keeps the glob as a live Seatbelt regex. Linux SRT expands deny globs
 * before launch, so its profile can cover only the sibling entries present then.
 */
export function ownProjectWorktreeDenies(input: {
  root: string
  worktree: string
  form: WorktreeDenyForm
  entries: readonly string[]
}): string[] {
  const root = resolve(input.root)
  const worktree = resolve(input.worktree)
  if (input.form === 'live-glob') return [join(root, '*')]
  return input.entries
    .map((entry) => resolve(entry))
    .filter((entry) => isAtOrBelow(entry, root) && !isAtOrBelow(worktree, entry))
}

/** Broad machine areas hidden from workers, with only run-owned paths carved back in. */
export function areaReadPolicy(input: {
  worktree: string
  runtimeDir: string
  scratchDir?: string
  project: Project | null
  registeredProjects: readonly Project[]
  environment: StateEnvironment
  worktreeDenyForm: WorktreeDenyForm
  ownWorktreeRootEntries: readonly string[]
}): AreaReadPolicy {
  const worktree = resolve(input.worktree)
  const runtimeDir = resolve(input.runtimeDir)
  const scratchDir = input.scratchDir ? resolve(input.scratchDir) : null
  const ownMain = input.project ? resolve(input.project.path) : null
  const state = resolveStatePaths(input.environment)
  const hubDatabase = resolveHubDatabase(input.environment)
  const orchestratorDatabase = resolveOrchestratorDatabase(input.environment)
  const runsDirectory = resolveRunsDirectory(input.environment)
  const checkoutParents = input.registeredProjects.map((project) => dirname(resolve(project.path)))
  const worktreeRoots = input.registeredProjects.flatMap((project) => {
    const root = resolve(mainCheckoutWorktreeHint(project.path))
    return input.project && project.recordId === input.project.recordId
      ? ownProjectWorktreeDenies({
          root,
          worktree,
          form: input.worktreeDenyForm,
          entries: input.ownWorktreeRootEntries,
        })
      : [root]
  })
  const siblingCheckouts = input.registeredProjects
    .filter((project) => !input.project || project.recordId !== input.project.recordId)
    .map((project) => resolve(project.path))
  return {
    deny: [
      ...new Set([
        state.root,
        dirname(orchestratorDatabase),
        orchestratorDatabase,
        runsDirectory,
        ...checkoutParents,
        ...siblingCheckouts,
        ...worktreeRoots,
      ]),
    ],
    allow: [
      ...new Set([
        worktree,
        runtimeDir,
        runHarnessStateDir(runtimeDir),
        ...(scratchDir ? [dirname(scratchDir), scratchDir] : []),
        hubDatabase,
        `${hubDatabase}-wal`,
        `${hubDatabase}-shm`,
        ...(ownMain ? [ownMain, join(ownMain, '.git')] : []),
      ]),
    ],
  }
}
