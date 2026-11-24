// concern: project task list read
/** Owns the expensive project-wide task list read reserved for declared list surfaces. */

import { LIVE_TASK_STATUS_CATEGORIES } from '../../../shared/trackers.ts'
import { taskReader } from './task-read-port.ts'
import { type HubTaskReference, taskReference } from './workflow-task-reference.ts'

export type ProjectTaskListReader = (
  project: string,
  filters?: { status?: string; parent?: string },
) => Promise<HubTaskReference[]>

export async function readProjectTaskList(
  project: string,
  filters: { status?: string; parent?: string } = {},
): Promise<HubTaskReference[]> {
  return (await taskReader().list({ project, ...filters })).map(taskReference)
}

export async function readLocalProjectTasks(
  project: string,
  filters: { status?: string; parent?: string } = {},
): Promise<HubTaskReference[]> {
  return (await taskReader().listLocal({ project, ...filters })).map(taskReference)
}

export async function readLiveProjectTasks(
  reader: ProjectTaskListReader,
  project: string,
): Promise<HubTaskReference[]> {
  return (
    await Promise.all(LIVE_TASK_STATUS_CATEGORIES.map((status) => reader(project, { status })))
  ).flat()
}
