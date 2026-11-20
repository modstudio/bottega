// concern: filesystem discovery for the own project's worktree-root entries.

import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { mainCheckoutWorktreeHint, type Project } from '../project/projects.ts'

export function ownWorktreeRootEntries(project: Project | null): string[] {
  if (!project) return []
  const root = resolve(mainCheckoutWorktreeHint(project.path))
  try {
    return readdirSync(root).map((entry) => join(root, entry))
  } catch {
    return []
  }
}
