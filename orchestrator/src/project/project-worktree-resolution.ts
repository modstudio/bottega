// concern: project worktree lifecycle resolution
/** Resolves declared project lifecycle settings with the repository-local default. */

import { existsSync } from 'node:fs'
import {
  type LifecycleForm,
  resolvedProjectWorktreeLifecycle,
} from '../worktree/worktree-lifecycle.ts'
import type { StoredProjectSettings, WorktreeTool } from './project-settings.ts'

type WorktreeProject = { path: string; settings: StoredProjectSettings }

export function projectLifecycleForm(
  project: WorktreeProject,
  fileExists: (path: string) => boolean = existsSync,
): LifecycleForm {
  return resolvedProjectWorktreeLifecycle(project.settings.worktree, project.path, fileExists).form
}

export function resolvedWorktreeTool(
  project: WorktreeProject | null | undefined,
  fileExists: (path: string) => boolean = existsSync,
): WorktreeTool | null {
  if (!project) return null
  const declared = project.settings.worktree
  const resolution = resolvedProjectWorktreeLifecycle(declared, project.path, fileExists)
  if (resolution.form === 'tracked-recipe' && resolution.source === 'default') {
    return { ...declared, recipePath: resolution.recipePath }
  }
  return declared ?? null
}
