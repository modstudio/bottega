// concern: project sweep adapter
/** Applies the held-tree decision to one project's declared sweep command. */

import { existsSync, realpathSync } from 'node:fs'
import type { Project } from '../project/projects.ts'
import { projectAt } from '../project/projects.ts'
import { sweepWithTool } from '../worktree/worktree-remove.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { withCleanupLock } from './cleanup.ts'
import { decideProjectSweep } from './cleanup-sweep-decisions.ts'

export type ProjectSweepOutcome = { failed: boolean; keep: { line: string; reason: string } | null }

export function heldProjectTrees(): {
  byProject: Map<string, Set<string>>
  hold: (path: string | null) => void
} {
  const byProject = new Map<string, Set<string>>()
  const hold = (path: string | null) => {
    if (!path || !existsSync(path)) return
    const canonical = realpathSync(path)
    const project = projectAt(canonical)
    if (!project) return
    const paths = byProject.get(project.name) ?? new Set<string>()
    paths.add(canonical)
    byProject.set(project.name, paths)
  }
  return { byProject, hold }
}

export function sweepProject(input: {
  project: Project
  heldPaths: string[]
  dryRun: boolean
  presentation: CleanupPresentation
}): ProjectSweepOutcome {
  const { project, heldPaths, dryRun, presentation } = input
  const tool = project.settings.worktree!
  const decision = decideProjectSweep({
    heldPaths,
    honorsHeld: tool.sweep_honors_held === true,
    dryRun,
  })
  if (decision.action === 'skip') {
    return {
      failed: false,
      keep: {
        line: `kept project sweep ${project.name}: ${decision.reason}`,
        reason: 'project sweep held',
      },
    }
  }
  if (!decision.execute) return { failed: false, keep: null }
  try {
    const result = withCleanupLock(project.path, `project sweep for ${project.name}`, null, () =>
      sweepWithTool(tool, project.path, decision.environment),
    )
    if (!result) return { failed: false, keep: null }
    if (result.out.trim()) {
      const lines = result.out.trim().split('\n')
      const omitted = Math.max(0, lines.length - 8)
      presentation.log(`\n${project.name} sweep:\n${lines.slice(-8).join('\n')}`)
      if (omitted)
        presentation.log(`  (${omitted} earlier line${omitted === 1 ? '' : 's'} omitted)`)
    }
    if (result.ok) return { failed: false, keep: null }
    presentation.error(
      `project ${project.name} sweep failed with exit status ${result.exitCode ?? 'unknown'}`,
    )
  } catch (error) {
    presentation.error(
      `project ${project.name} sweep failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { failed: true, keep: null }
}
