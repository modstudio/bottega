// concern: default local project retirement
/** Removes the unused built-in local-only project after an install binds to a hosted record. */

import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, rmdirSync } from 'node:fs'
import type { StateEnvironment } from '../../../shared/state-directory.ts'
import { db } from '../database/db.ts'
import {
  DEFAULT_LOCAL_PROJECT_NAME,
  DEFAULT_LOCAL_PROJECT_SETTINGS,
  defaultLocalProjectPath,
} from '../database/project-register-store.ts'
import { projectByName } from './project-read.ts'
import { localProjectReferenceCounts } from './project-reference-counts.ts'
import { stableSettingsJson, type StoredProjectSettings } from './project-settings.ts'

export type DefaultLocalProjectRetirementFacts = {
  projectName: string
  projectPath: string
  defaultProjectPath: string
  projectSettings: StoredProjectSettings
  hasSpace: boolean
  referenced: boolean
}

export function shouldRetireDefaultLocalProject(
  facts: DefaultLocalProjectRetirementFacts,
): boolean {
  return (
    facts.projectName === DEFAULT_LOCAL_PROJECT_NAME &&
    facts.projectPath === facts.defaultProjectPath &&
    stableSettingsJson(facts.projectSettings) ===
      stableSettingsJson(DEFAULT_LOCAL_PROJECT_SETTINGS) &&
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

export async function retireUnusedDefaultLocalProject(
  database: Database = db(),
  environment: StateEnvironment = process.env,
): Promise<boolean> {
  const project = projectByName(DEFAULT_LOCAL_PROJECT_NAME, database)
  if (!project) return false
  const counts = await localProjectReferenceCounts(database, project.recordId)
  const shouldRetire = shouldRetireDefaultLocalProject({
    projectName: project.name,
    projectPath: project.path,
    defaultProjectPath: defaultLocalProjectPath(environment),
    projectSettings: project.settings,
    hasSpace: Boolean(project.settings.space),
    referenced: Object.values(counts).some((count) => count > 0),
  })
  if (!shouldRetire) return false
  const removed =
    database.query('DELETE FROM project WHERE record_id = ?').run(project.recordId).changes > 0
  if (removed) removeEmptyDirectory(project.path)
  return removed
}
