// concern: stray worktree directory sweep
/** Applies the shared archive decision under the project's cleanup lock. */
import type { Database } from 'bun:sqlite'
import { type CleanupPresentation, withCleanupLock } from './cleanup.ts'
import {
  archiveStrayWorktreeDirectory,
  inventoryStrayWorktreeDirectories,
  type StrayWorktreeDirectory,
  type StrayWorktreeProject,
} from './stray-worktree-inventory.ts'

type SweepInput = {
  projects: StrayWorktreeProject[]
  database: Database
  dryRun: boolean
  presentation: Pick<CleanupPresentation, 'log' | 'error'>
  nowMs?: number
}

function archiveDirectory(
  input: SweepInput,
  project: StrayWorktreeProject,
  directory: StrayWorktreeDirectory,
  description: string,
): boolean {
  try {
    let failed = false
    withCleanupLock(project.path, `archive ${description}`, directory.path, () => {
      const refreshed = inventoryStrayWorktreeDirectories({
        project,
        database: input.database,
        nowMs: Date.now(),
      })
      const candidate = refreshed.directories.find((item) => item.path === directory.path)
      if (refreshed.errors.length || candidate?.decision !== 'archive') {
        const reason = refreshed.errors[0] ?? candidate?.decision ?? 'directory is absent'
        input.presentation.log(`kept ${description}; refreshed decision ${reason}`)
        return
      }
      const result = archiveStrayWorktreeDirectory({ directory: candidate })
      if (result.ok) input.presentation.log(`archived ${description} at ${result.destination}`)
      else {
        failed = true
        input.presentation.error(`could not archive ${description}: ${result.error}`)
      }
    })
    return failed
  } catch (error) {
    input.presentation.error(
      `could not archive ${description}: ${String((error as Error).message ?? error)}`,
    )
    return true
  }
}

function sweepDirectory(
  input: SweepInput,
  project: StrayWorktreeProject,
  directory: StrayWorktreeDirectory,
): boolean {
  const description = `stray directory ${project.name} ${directory.path}`
  if (directory.decision !== 'archive') {
    input.presentation.log(
      `${input.dryRun ? 'would keep' : 'kept'} ${description}; decision ${directory.decision}${directory.reason ? `: ${directory.reason}` : ''}`,
    )
    return false
  }
  if (input.dryRun) {
    input.presentation.log(`would archive ${description}`)
    return false
  }
  return archiveDirectory(input, project, directory, description)
}

export function sweepStrayWorktreeDirectories(input: SweepInput): boolean {
  let failed = false
  const nowMs = input.nowMs ?? Date.now()
  for (const project of input.projects) {
    const inventory = inventoryStrayWorktreeDirectories({
      project,
      database: input.database,
      nowMs,
    })
    for (const error of inventory.errors) {
      failed = true
      input.presentation.error(error)
    }
    for (const directory of inventory.directories)
      failed = sweepDirectory(input, project, directory) || failed
  }
  return failed
}
