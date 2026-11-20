// concern: pure broad-area read policy; must not know sandbox-runtime or secret paths.

import { dirname, join, resolve } from 'node:path'
import {
  resolveHubDatabase,
  resolveOrchestratorDatabase,
  resolveRunsDirectory,
  resolveStatePaths,
  type StateEnvironment,
} from '../../../shared/state-directory.ts'
import type { Project } from '../project/projects.ts'
import { runHarnessStateDir } from '../run-owned-paths.ts'

export type AreaReadPolicy = { deny: string[]; allow: string[] }

/** Broad machine areas hidden from workers, with only run-owned paths carved back in. */
export function areaReadPolicy(input: {
  worktree: string
  runtimeDir: string
  scratchDir?: string
  project: Project | null
  registeredProjects: readonly Project[]
  environment: StateEnvironment
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
