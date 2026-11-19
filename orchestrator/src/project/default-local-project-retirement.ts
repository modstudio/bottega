// concern: default local project retirement
/** Removes the unused local-only project when an install first binds to a hosted record. */

import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, rmdirSync } from 'node:fs'
import { db } from '../database/db.ts'
import { DEFAULT_LOCAL_PROJECT_NAME } from '../database/project-register-store.ts'
import { projectByName } from './project-read.ts'
import { localProjectReferenceCounts } from './project-reference-counts.ts'

export type DefaultLocalProjectRetirementFacts = {
  alreadyBound: boolean
  projectName: string
  hasSpace: boolean
  referenced: boolean
}

export function shouldRetireDefaultLocalProject(
  facts: DefaultLocalProjectRetirementFacts,
): boolean {
  return (
    !facts.alreadyBound &&
    facts.projectName === DEFAULT_LOCAL_PROJECT_NAME &&
    !facts.hasSpace &&
    !facts.referenced
  )
}

function removeEmptyDirectory(path: string): void {
  if (!existsSync(path) || readdirSync(path).length > 0) return
  try {
    rmdirSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
  }
}

export async function retireUnusedDefaultLocalProjectAtFirstBinding(
  alreadyBound: boolean,
  database: Database = db(),
): Promise<boolean> {
  if (alreadyBound) return false
  const project = projectByName(DEFAULT_LOCAL_PROJECT_NAME, database)
  if (!project) return false
  const counts = await localProjectReferenceCounts(database, project.recordId)
  const shouldRetire = shouldRetireDefaultLocalProject({
    alreadyBound,
    projectName: project.name,
    hasSpace: Boolean(project.settings.space),
    referenced: Object.values(counts).some((count) => count > 0),
  })
  if (!shouldRetire) return false
  const removed =
    database.query('DELETE FROM project WHERE record_id = ?').run(project.recordId).changes > 0
  if (removed) removeEmptyDirectory(project.path)
  return removed
}
