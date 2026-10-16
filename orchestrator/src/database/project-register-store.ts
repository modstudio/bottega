// concern: project-register-store
/** Owns project-register row writes and the fresh-store local project. Must not know commands, runs, routing, or hosted records. */
import type { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { resolveStateRoot, type StateEnvironment } from '../../../shared/state-directory.ts'
import type { ProjectSettings, StoredProjectSettings } from '../project/project-settings.ts'

export const DEFAULT_LOCAL_PROJECT_NAME = 'tasks'
const DEFAULT_LOCAL_PROJECT_PREFIX = 'TASK'
const DEFAULT_LOCAL_PROJECT_DIRECTORY = 'tasks'

export const DEFAULT_LOCAL_PROJECT_SETTINGS: ProjectSettings = {
  tracker: { kind: 'hub', protocol: 'hub' },
  keyPrefixes: [DEFAULT_LOCAL_PROJECT_PREFIX],
}

export type ProjectRegisterWrite = {
  recordId: string
  name: string
  path: string
  stack?: string | null
  canon?: boolean
  settings?: ProjectSettings | StoredProjectSettings
}

/** The one local row writer used by project commands and store bootstrap. */
export function writeProjectRegisterRow(database: Database, project: ProjectRegisterWrite): void {
  database
    .query(
      `INSERT INTO project (record_id, name, path, stack, canon, settings, retired_at) VALUES (?,?,?,?,?,?,NULL)
       ON CONFLICT(name) DO UPDATE SET path=excluded.path, stack=excluded.stack,
                                       canon=excluded.canon, settings=excluded.settings,
                                       record_id=COALESCE(project.record_id, excluded.record_id),
                                       retired_at=NULL`,
    )
    .run(
      project.recordId,
      project.name,
      project.path.replace(/\/$/, ''),
      project.stack ?? null,
      project.canon ? 1 : 0,
      JSON.stringify(project.settings ?? {}),
    )
}

/** Register the built-in tracker project only while creating a brand-new store. */
export function initializeDefaultLocalProject(
  database: Database,
  newStore: boolean,
  environment: StateEnvironment = process.env,
): void {
  if (!newStore) return
  const exists = database
    .query('SELECT 1 FROM project WHERE name = ?')
    .get(DEFAULT_LOCAL_PROJECT_NAME)
  if (exists) return
  const path = join(resolveStateRoot(environment), 'projects', DEFAULT_LOCAL_PROJECT_DIRECTORY)
  mkdirSync(path, { recursive: true })
  writeProjectRegisterRow(database, {
    recordId: newRecordId(),
    name: DEFAULT_LOCAL_PROJECT_NAME,
    path,
    stack: null,
    canon: false,
    settings: DEFAULT_LOCAL_PROJECT_SETTINGS,
  })
}
