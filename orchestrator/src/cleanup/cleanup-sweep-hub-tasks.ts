// concern: cleanup sweep task state
/** Shares one hub read between run-link repair and done-task context cleanup. */

import { listContextHolders } from '../doc/context-item-store.ts'
import { clearTaskHolderForLifecycle } from '../doc/context-service.ts'
import { projects } from '../project/projects.ts'
import { sweepRunTaskLinks } from '../run/run-task-linking.ts'
import type { ProjectTaskListReader } from '../workflow/project-task-list.ts'
import { type HubTaskReference, taskReadRefusal } from '../workflow/workflow-task-reference.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { decideTaskContextReap } from './task-context-reap-decision.ts'

function sharedTaskReader(reader: ProjectTaskListReader): ProjectTaskListReader {
  const reads = new Map<string, Promise<HubTaskReference[]>>()
  return (project, filters) => {
    const key = `${project}\0${filters?.status ?? ''}\0${filters?.parent ?? ''}`
    let read = reads.get(key)
    if (!read) {
      read = reader(project, filters)
      reads.set(key, read)
    }
    return read
  }
}

export async function sweepHubTasks(
  dryRun: boolean,
  hubTaskReader: ProjectTaskListReader,
  selectedProject: string | null,
  presentation: CleanupPresentation,
): Promise<boolean> {
  const reader = sharedTaskReader(hubTaskReader)
  const runLinks = await sweepRunTaskLinks(dryRun, reader)
  presentation[runLinks.kind](runLinks.line)
  if (selectedProject !== null) return runLinks.kind === 'error'
  let tasks: HubTaskReference[]
  try {
    tasks = (
      await Promise.all(
        projects().map(async (project) => {
          try {
            return await reader(project.name)
          } catch (error) {
            throw taskReadRefusal(
              project.name,
              error instanceof Error ? error.message : String(error),
            )
          }
        }),
      )
    ).flat()
  } catch (error) {
    presentation.error(
      `task context unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
    return true
  }
  const decision = decideTaskContextReap(
    (await listContextHolders('task')).map((holder) => ({
      holderId: holder.holderId,
      itemCount: holder.items.length,
    })),
    tasks,
  )
  let cleared = 0
  let removed = 0
  let alreadyAbsent = 0
  let failed = false
  for (const holder of decision.clear) {
    try {
      const result = await clearTaskHolderForLifecycle({
        holderId: holder.holderId,
        project: holder.project,
        dryRun,
      })
      cleared++
      removed += result.removed
      alreadyAbsent += result.alreadyAbsent
    } catch (error) {
      failed = true
      presentation.error(
        `task context clear failed ${holder.project}:${holder.key}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  presentation.log(
    dryRun
      ? `task context: would clear ${cleared} done tasks, would remove ${removed} items, already absent ${alreadyAbsent}, kept ${decision.keptOpen} open, unresolved ${decision.unresolved.length}`
      : `task context: cleared ${cleared} done tasks, removed ${removed} items, already absent ${alreadyAbsent}, kept ${decision.keptOpen} open, unresolved ${decision.unresolved.length}`,
  )
  return failed || runLinks.kind === 'error'
}
