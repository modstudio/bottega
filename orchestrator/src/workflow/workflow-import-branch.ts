// concern: workflow import landing-branch resolution
/** Resolves the merge base required before a workflow import may write drafts. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { Project } from '../project/projects.ts'
import { resolveReviewBase } from '../review/review-target.ts'
import { resolveBase } from '../worktree/worktree-caller.ts'

export function workflowImportBase(root: string, project: Project | null): string {
  const trunk = project?.settings.trunk?.trim()
  if (!trunk) {
    throw new Error(
      project
        ? `workflow import refused: registered project ${project.name} has no landing branch in settings.trunk; ` +
            `run ${PLATFORM_SLUG} project set ${project.name} --settings to set trunk`
        : "workflow import refused: no registered project owns this directory; run from a registered project's checkout",
    )
  }
  let base: string | null = null
  let resolutionFailure: string | null = null
  try {
    const head = resolveBase(root, 'HEAD')
    base = resolveReviewBase(root, head, trunk)
  } catch (cause) {
    resolutionFailure = cause instanceof Error ? cause.message : String(cause)
  }
  if (base) return base
  throw new Error(
    `workflow import refused: no merge base with registered landing branch ${trunk}; ` +
      `${resolutionFailure ? `${resolutionFailure}; ` : ''}fetch ${trunk} into ${root}, then retry`,
  )
}
