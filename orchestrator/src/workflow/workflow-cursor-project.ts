// concern: workflow cursor project resolution
/** Resolves the project scope used by a public workflow cursor handle. */

import type { Database } from 'bun:sqlite'
import { projectAt } from '../project/projects.ts'

/** An explicit project wins; otherwise a handle belongs to the registered cwd project. */
export function workflowCursorProject(
  project: string | undefined,
  cwd: string,
  database: Database,
): string | undefined {
  return project ?? projectAt(cwd, database)?.name
}
