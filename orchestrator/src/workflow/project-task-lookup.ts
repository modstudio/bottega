// concern: project task lookup
/** Reads only named task keys, their ancestors, and child-presence facts. */

import { taskReader } from './task-read-port.ts'
import { type HubTaskReference, taskReference } from './workflow-task-reference.ts'

export type ProjectTaskLookupReader = (
  project: string,
  keys: string[],
) => Promise<HubTaskReference[]>

export async function lookupProjectTasks(
  project: string,
  keys: string[],
): Promise<HubTaskReference[]> {
  if (!keys.length) return []
  return (await taskReader().lookup(project, [...new Set(keys)])).map(taskReference)
}
