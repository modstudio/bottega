// concern: workflow cursor project resolution
/** Resolves the project scope used by a public workflow cursor handle. */

import type { Database } from 'bun:sqlite'
import { projectAt, projectByName } from '../project/projects.ts'

/** An explicit project wins; otherwise a handle belongs to the registered cwd project. */
export function workflowCursorProject(
  project: string | undefined,
  cwd: string,
  database: Database,
): string | undefined {
  return project ?? projectAt(cwd, database)?.name
}

export function workflowCursorProjectUsesHubTracker(project: string, database: Database): boolean {
  return projectByName(project, database)?.settings.tracker?.protocol === 'hub'
}

export function hubTrackerKeyNamesNoTask(
  project: string,
  taskRecordId: string | null,
  database: Database,
): boolean {
  return workflowCursorProjectUsesHubTracker(project, database) && taskRecordId === null
}
