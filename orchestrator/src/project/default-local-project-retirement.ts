// concern: default local project retirement
/** Removes the unused built-in local-only project after an install binds to a hosted record. */

import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, rmdirSync } from 'node:fs'
import { db } from '../database/db.ts'
import {
  DEFAULT_LOCAL_PROJECT_NAME,
  DEFAULT_LOCAL_PROJECT_SETTINGS,
  defaultLocalProjectPath,
  deleteProjectRegisterRow,
} from '../database/project-register-store.ts'
import { type ProjectTaskListReader, readLocalProjectTasks } from '../workflow/project-task-list.ts'
import { projectByName } from './project-read.ts'
import { projectReferenceCounts } from './project-reference-counts.ts'
import type { StoredProjectSettings } from './project-settings.ts'

type DefaultLocalProjectRetirementFacts = {
  projectName: string
  projectPath: string
  defaultProjectPath: string
  projectSettings: StoredProjectSettings
  referenced: boolean
  taskCount: number
}

type Presentation = { log(value: string): void }

function shouldRetireDefaultLocalProject(facts: DefaultLocalProjectRetirementFacts): boolean {
  return (
    facts.projectName === DEFAULT_LOCAL_PROJECT_NAME &&
    facts.projectPath === facts.defaultProjectPath &&
    Bun.deepEquals(facts.projectSettings, DEFAULT_LOCAL_PROJECT_SETTINGS) &&
    !facts.referenced &&
    facts.taskCount === 0
  )
}

function removeEmptyDirectory(path: string): void {
  if (!existsSync(path) || readdirSync(path).length > 0) return
  try {
    rmdirSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
      console.warn(
        `default local project directory removal failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

export async function retireUnusedDefaultLocalProject(
  database: Database = db(),
  environment: Parameters<typeof defaultLocalProjectPath>[0] = process.env,
  hubTaskReader: ProjectTaskListReader = readLocalProjectTasks,
  referenceCounter: typeof projectReferenceCounts = projectReferenceCounts,
): Promise<boolean> {
  const project = projectByName(DEFAULT_LOCAL_PROJECT_NAME, database)
  if (!project) return false
  const counts = await referenceCounter(database, project.recordId)
  let taskCount: number
  try {
    taskCount = (await hubTaskReader(project.name)).length
  } catch (error) {
    console.warn(
      `default local project task read failed; keeping project: ${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
  const shouldRetire = shouldRetireDefaultLocalProject({
    projectName: project.name,
    projectPath: project.path,
    defaultProjectPath: defaultLocalProjectPath(environment),
    projectSettings: project.settings,
    referenced: Object.values(counts).some((count) => count > 0),
    taskCount,
  })
  if (!shouldRetire) return false
  const removed = deleteProjectRegisterRow(database, project.recordId)
  if (removed) removeEmptyDirectory(project.path)
  return removed
}

export async function attemptDefaultLocalProjectRetirement(
  presentation: Presentation,
  retire: () => Promise<boolean> = retireUnusedDefaultLocalProject,
): Promise<void> {
  try {
    if (await retire())
      presentation.log(`retired unused default local project ${DEFAULT_LOCAL_PROJECT_NAME}`)
  } catch (error) {
    presentation.log(
      `default local project retirement failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
