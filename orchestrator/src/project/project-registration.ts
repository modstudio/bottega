// concern: project-registration
/** Owns the atomic local row, hosted-space route, and cache rewind for registration. */
import type { Database } from 'bun:sqlite'
import { db, writeTransaction } from '../database/db.ts'
import { writeProjectRegisterRow } from '../database/project-register-store.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import { rewindRecordCacheForProjectRegistration } from '../record/record-cache-registration.ts'
import { type Project, projectSettingsForStorage } from './projects.ts'

export function registerLocalProject(
  project: Project,
  spaceId: string | null,
  local: Database = db(true),
): void {
  writeTransaction(() => {
    writeProjectRegisterRow(local, {
      ...project,
      settings: projectSettingsForStorage(project.settings),
    })
    if (spaceId === null) return
    rememberProjectSpace(local, project.name, spaceId)
    rewindRecordCacheForProjectRegistration(local, spaceId)
  }, local)
}
