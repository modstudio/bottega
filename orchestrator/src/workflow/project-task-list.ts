// concern: project task list read
/** Owns the expensive project-wide task list read reserved for declared list surfaces. */

import { taskReader } from './task-read-port.ts'
import type { HubTaskReference } from './workflow-task-reference.ts'

export type ProjectTaskListReader = (project: string) => Promise<HubTaskReference[]>

export async function readProjectTaskList(project: string): Promise<HubTaskReference[]> {
  return taskReader().list({ project })
}
