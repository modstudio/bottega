// concern: project sweep adapter
/** Applies the held-tree decision to one project's declared sweep command. */

import { existsSync, realpathSync } from 'node:fs'
import { namedProjectTreePaths } from '../close/tree-keep.ts'
import type { Project } from '../project/projects.ts'
import { sweepWithTool } from '../worktree/worktree-remove.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { withCleanupLock } from './cleanup.ts'
import { decideProjectSweep } from './cleanup-sweep-decisions.ts'

export type ProjectSweepOutcome = { failed: boolean; keep: { line: string; reason: string } | null }

export function heldProjectTrees(): {
  byProject: Map<string, Set<string>>
  add: (projectName: string, path: string | null) => void
} {
  const byProject = new Map<string, Set<string>>()
  const add = (projectName: string, path: string | null) => {
    if (!path || !existsSync(path)) return
    let canonical: string
    try {
      canonical = realpathSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const paths = byProject.get(projectName) ?? new Set<string>()
    paths.add(canonical)
    byProject.set(projectName, paths)
  }
  return { byProject, add }
}

/**
 * Then the PROJECT'S OWN sweep, which knows what orchestrator cannot.
 *
 * A database whose worktree directory was deleted by hand is invisible to
 * everything above — no row points at it, and there is nothing left to
 * remove. Each project's tool is the only thing that can find those, and
 * running it is the difference between reclaiming directories and
 * reclaiming disk. It runs only when the held-tree decision allows it.
 */
export function sweepProject(input: {
  project: Project
  heldPaths: ReadonlySet<string>
  dryRun: boolean
  presentation: CleanupPresentation
}): ProjectSweepOutcome {
  const { project, heldPaths, dryRun, presentation } = input
  const tool = project.settings.worktree!
  try {
    const outcome = withCleanupLock(project.path, `project sweep for ${project.name}`, null, () => {
      const current = heldProjectTrees()
      for (const path of heldPaths) current.add(project.name, path)
      for (const path of namedProjectTreePaths(project.name)) current.add(project.name, path)
      const decision = decideProjectSweep({
        heldPaths: [...(current.byProject.get(project.name) ?? [])].sort(),
        honorsHeld: tool.sweep_honors_held === true,
        dryRun,
      })
      return decision.action === 'skip'
        ? decision
        : {
            ...decision,
            result: decision.execute
              ? sweepWithTool(tool, project.path, decision.environment)
              : null,
          }
    })
    if (outcome.action === 'skip') {
      return {
        failed: false,
        keep: {
          line: `kept project sweep ${project.name}: ${outcome.reason}`,
          reason: 'project sweep held',
        },
      }
    }
    const { result } = outcome
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
