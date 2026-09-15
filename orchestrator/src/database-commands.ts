// concern: database
/** Owns database maintenance command behavior. Must not know CLI grammar. */
import { backfillSpecSha, migrateDatabase } from './db.ts'
import { reconcileRun } from './run-artifacts.ts'

export type DatabaseCommandPresentation = { log(value: string): void }

export function migrateCommand(presentation: DatabaseCommandPresentation): void {
  const migrated = migrateDatabase()
  if (migrated.versions.length === 0) presentation.log(`schema already current: ${migrated.path}`)
  else {
    presentation.log(`migrated ${migrated.path}`)
    for (const version of migrated.versions) presentation.log(`  applied ${version}`)
  }
  const backfilled = backfillSpecSha()
  presentation.log(
    `spec_sha backfill: ${backfilled.updated} updated, ${backfilled.missing} prompt files missing`,
  )
}

export function reconcileCommand(id: number, presentation: DatabaseCommandPresentation): void {
  presentation.log(reconcileRun(id))
}
