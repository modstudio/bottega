// concern: run task reference
/** Resolves an optional durable bottega task identity without making hub availability a dispatch prerequisite. */

import { projects } from '../project/projects.ts'
import {
  type HubTaskReference,
  resolveHubTaskReference,
} from '../workflow/workflow-task-reference.ts'
import { deriveNewRunLinks } from './run-task-linking.ts'

export const RUN_REFERENCE_REFUSAL =
  'a run that is not a probe must reference a task or a project; run from a registered project or pass a task key'

/** Refuses a run before its insert reaches the store backstop. */
function assertRunHasTaskOrProject(input: {
  probe: boolean
  taskRecordId: string | null
  projectRecordId: string | null
}): void {
  if (!input.probe && !input.taskRecordId && !input.projectRecordId) {
    throw new Error(RUN_REFERENCE_REFUSAL)
  }
}

async function bestEffortTaskReference(
  project: string | null,
  key: string,
): Promise<HubTaskReference | null> {
  if (!project) return null
  try {
    return await resolveHubTaskReference(project, key)
  } catch {
    return null
  }
}

/** Applies the link-run derivation to the facts available before a new row is inserted. */
export async function admitNewRunReference(input: {
  inheritedTaskRecordId?: string | null
  inheritedProjectRecordId?: string | null
  projectName: string | null
  projectRecordId: string | null
  key: string | null
  cwd: string | null
  launchCwd: string | null
  probe: boolean
}): Promise<{ taskRecordId: string | null; projectRecordId: string | null }> {
  const task = input.key ? await bestEffortTaskReference(input.projectName, input.key) : null
  const taskMap = new Map<string, HubTaskReference>()
  if (task) taskMap.set(task.key, task)
  const links = deriveNewRunLinks(
    {
      key: input.key,
      inheritedTaskRecordId: input.inheritedTaskRecordId,
      inheritedProjectRecordId: input.inheritedProjectRecordId,
      projectRecordId: input.projectRecordId,
      cwd: input.cwd,
      launchCwd: input.launchCwd,
      probe: input.probe,
    },
    taskMap,
    projects(),
  )
  assertRunHasTaskOrProject({
    probe: input.probe,
    taskRecordId: links.taskRecordId,
    projectRecordId: links.projectRecordId,
  })
  return links
}
