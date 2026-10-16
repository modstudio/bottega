// concern: database
/** Owns database maintenance command behavior. Must not know CLI grammar. */

import { fillProjectRecordIds } from '../project/project-record-identity.ts'
import { reconcileRun } from '../run/run-artifacts.ts'
import { backfillSpecSha, migrateDatabase, withDatabaseForMigrationStep } from './db.ts'
import { migrationApplied } from './migrations.ts'

export type DatabaseCommandPresentation = { log(value: string): void }
type MigrateCommandActions = {
  migrate(input?: { beforeMigration?: string }): { path: string; versions: string[] }
  contracted(): Promise<boolean>
  fill(): Promise<unknown>
  backfill(): { updated: number; missing: number }
}

const PROJECT_IDENTITY_CONTRACT_MIGRATION = '0115_project_identity_contract'

export async function migrateCommand(
  presentation: DatabaseCommandPresentation,
  actions: MigrateCommandActions = {
    migrate: migrateDatabase,
    contracted: () =>
      withDatabaseForMigrationStep(async (database) =>
        migrationApplied(database, PROJECT_IDENTITY_CONTRACT_MIGRATION),
      ),
    fill: () => withDatabaseForMigrationStep((database) => fillProjectRecordIds(database)),
    backfill: backfillSpecSha,
  },
): Promise<void> {
  const alreadyContracted = await actions.contracted()
  const before = alreadyContracted
    ? { path: '', versions: [] }
    : actions.migrate({ beforeMigration: PROJECT_IDENTITY_CONTRACT_MIGRATION })
  if (!alreadyContracted) await actions.fill()
  const after = actions.migrate()
  const migrated = { path: after.path, versions: [...before.versions, ...after.versions] }
  if (migrated.versions.length === 0) presentation.log(`schema already current: ${migrated.path}`)
  else {
    presentation.log(`migrated ${migrated.path}`)
    for (const version of migrated.versions) presentation.log(`  applied ${version}`)
  }
  const backfilled = actions.backfill()
  presentation.log(
    `spec_sha backfill: ${backfilled.updated} updated, ${backfilled.missing} prompt files missing`,
  )
}

export function reconcileCommand(id: number, presentation: DatabaseCommandPresentation): void {
  presentation.log(reconcileRun(id))
}
