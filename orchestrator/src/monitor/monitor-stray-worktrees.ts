// concern: stray worktree monitor conditions
/** Presents the shared stray-directory inventory without changing filesystem state. */
import type { Database } from 'bun:sqlite'
import type {
  StrayWorktreeDirectory,
  StrayWorktreeProject,
} from '../cleanup/stray-worktree-inventory.ts'
import { inventoryStrayWorktreeDirectories } from '../cleanup/stray-worktree-inventory.ts'
import type { MonitorCondition } from './monitor-types.ts'

function conditionAction(decision: StrayWorktreeDirectory['decision']): string {
  if (decision === 'archive') return 'run orch sweep to archive it'
  if (decision === 'keep-claimed') return 'kept because a recorded pointer claims it'
  if (decision === 'keep-recent') return 'kept until it remains unchanged beyond the quiet window'
  return 'report only; establish a safe ordinary directory before cleanup'
}

function conditionFor(
  project: StrayWorktreeProject,
  directory: StrayWorktreeDirectory,
): MonitorCondition {
  const reason = directory.reason ? `; ${directory.reason}` : ''
  return {
    kind: 'stray-worktree-directory',
    subject: directory.path,
    since: new Date(directory.modifiedMs).toISOString(),
    ageMs: directory.ageMs,
    detail: `${project.name} stray worktree-root directory; decision ${directory.decision}${reason}`,
    action: conditionAction(directory.decision),
    affectedProject: project.name,
  }
}

export function strayWorktreeConditions(input: {
  projects: StrayWorktreeProject[]
  database: Database
  clock: number
}): { conditions: MonitorCondition[]; errors: string[] } {
  const conditions: MonitorCondition[] = []
  const errors: string[] = []
  for (const project of input.projects) {
    const inventory = inventoryStrayWorktreeDirectories({
      project,
      database: input.database,
      nowMs: input.clock,
    })
    errors.push(...inventory.errors)
    for (const directory of inventory.directories) conditions.push(conditionFor(project, directory))
  }
  return { conditions, errors }
}
