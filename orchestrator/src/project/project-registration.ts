// concern: project-registration
/** Owns the atomic local row and hosted-space route for registration. */
import type { Database } from 'bun:sqlite'
import { db, writeTransaction } from '../database/db.ts'
import { writeProjectRegisterRow } from '../database/project-register-store.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
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
  }, local)
}
