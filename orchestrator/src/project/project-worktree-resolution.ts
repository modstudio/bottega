// concern: project worktree lifecycle resolution
/** Resolves declared project lifecycle settings with the repository-local default. */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEFAULT_PROJECT_CONFIG_PATH,
  type LifecycleForm,
  type LifecycleResolution,
  resolveWorktreeLifecycle,
} from '../worktree/worktree-lifecycle.ts'
import type { StoredProjectSettings, WorktreeTool } from './project-settings.ts'

type WorktreeProject = { path: string; settings: StoredProjectSettings }

/** Apply the repository-local default without persisting derived config into the register. */
function resolvedProjectWorktreeLifecycle(
  project: WorktreeProject,
  fileExists: (path: string) => boolean = existsSync,
): LifecycleResolution {
  const declared = project.settings.worktree
  const resolution = resolveWorktreeLifecycle(declared)
  return resolution.form === 'none'
    ? resolveWorktreeLifecycle(
        declared,
        fileExists(resolve(project.path, DEFAULT_PROJECT_CONFIG_PATH)),
      )
    : resolution
}

export function projectLifecycleForm(
  project: WorktreeProject,
  fileExists: (path: string) => boolean = existsSync,
): LifecycleForm {
  return resolvedProjectWorktreeLifecycle(project, fileExists).form
}

export function resolvedWorktreeTool(
  project: WorktreeProject | null | undefined,
  fileExists: (path: string) => boolean = existsSync,
): WorktreeTool | null {
  if (!project) return null
  const declared = project.settings.worktree
  const resolution = resolvedProjectWorktreeLifecycle(project, fileExists)
  if (resolution.form === 'tracked-recipe' && resolution.source === 'default') {
    return { ...declared, recipePath: resolution.recipePath }
  }
  return declared ?? null
}
