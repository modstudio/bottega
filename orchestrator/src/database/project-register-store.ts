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

export function defaultLocalProjectPath(environment: StateEnvironment = process.env): string {
  return join(resolveStateRoot(environment), 'projects', DEFAULT_LOCAL_PROJECT_DIRECTORY)
}

export type ProjectRegisterWrite = {
  recordId: string
  recordRevision?: number | null
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
      `INSERT INTO project (record_id, record_revision, name, path, stack, canon, settings, retired_at) VALUES (?,?,?,?,?,?,?,NULL)
       ON CONFLICT(name) DO UPDATE SET path=excluded.path, stack=excluded.stack,
                                       canon=excluded.canon, settings=excluded.settings,
                                       record_id=COALESCE(project.record_id, excluded.record_id),
                                       record_revision=COALESCE(excluded.record_revision, project.record_revision),
                                       retired_at=NULL`,
    )
    .run(
      project.recordId,
      project.recordRevision ?? null,
      project.name,
      project.path.replace(/\/$/, ''),
      project.stack ?? null,
      project.canon ? 1 : 0,
      JSON.stringify(project.settings ?? {}),
    )
}

/** Delete one local project-register row by its stable identity; returns whether a row changed. */
export function deleteProjectRegisterRow(database: Database, recordId: string): boolean {
  return database.query('DELETE FROM project WHERE record_id = ?').run(recordId).changes > 0
}

/** Store the last hosted revision observed for one project-register row. */
export function storeProjectRecordRevision(
  database: Database,
  recordId: string,
  revision: number | null,
): void {
  database.query('UPDATE project SET record_revision=? WHERE record_id=?').run(revision, recordId)
}

/** Mirror a hosted row onto the local row it is linked to by record id, lifecycle included; returns rows changed. */
export function mirrorProjectRegisterRow(
  database: Database,
  project: Omit<ProjectRegisterWrite, 'path'> & { retiredAt: string | null },
): number {
  return database
    .query(
      'UPDATE project SET name=?,stack=?,canon=?,settings=?,retired_at=?,record_revision=? WHERE record_id=?',
    )
    .run(
      project.name,
      project.stack ?? null,
      project.canon ? 1 : 0,
      JSON.stringify(project.settings ?? {}),
      project.retiredAt,
      project.recordRevision ?? null,
      project.recordId,
    ).changes
}

/**
 * Register the built-in tracker project only while the store's register is unseeded. The durable
 * form of this state is the new_store_seed_pending schema_meta marker.
 */
export function initializeDefaultLocalProject(
  database: Database,
  seedPending: boolean,
  recordSessionPresent: boolean,
  environment: StateEnvironment = process.env,
): void {
  if (!seedPending || recordSessionPresent) return
  const exists = database
    .query('SELECT 1 FROM project WHERE name = ?')
    .get(DEFAULT_LOCAL_PROJECT_NAME)
  if (exists) return
  const path = defaultLocalProjectPath(environment)
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
