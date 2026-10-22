// concern: database
/** Owns database maintenance command behavior. Must not know CLI grammar. */

import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { fillProjectRecordIds } from '../project/project-record-identity.ts'
import {
  type MigrationInFlightRun,
  migrationInFlightRuns,
} from '../run/migration-in-flight-runs.ts'
import { reconcileRun } from '../run/run-artifacts.ts'
import { existingDatabaseMigrationRefusal } from './database-location.ts'
import { backfillSpecSha, DB_PATH, migrateDatabase, withDatabaseForMigrationStep } from './db.ts'
import { migrationApplied } from './migrations.ts'
import {
  applyRunFilesystemIdentityMigration,
  discoverRunFilesystemIdentityMigration,
  liveRunFilesystemMigrationRefusal,
  type RunFilesystemMigrationReport,
} from './run-filesystem-identity.ts'

export type DatabaseCommandPresentation = { log(value: string): void }
type MigrateCommandActions = {
  assertAuthority?(): void
  inFlightRuns(): Promise<MigrationInFlightRun[]>
  migrate(input?: { beforeMigration?: string }): {
    path: string
    versions: string[]
  }
  migrateCutover?(): {
    path: string
    versions: string[]
    files?: RunFilesystemMigrationReport
  }
  contracted(): Promise<boolean>
  fill(): Promise<unknown>
  backfill(): { updated: number; missing: number }
}

const PROJECT_IDENTITY_CONTRACT_MIGRATION = '0115_project_identity_contract'
const RUN_FILESYSTEM_IDENTITY_CUTOVER = '0121_run_filesystem_identity_cutover'

type MigrateCommandOptions = { authorityRefusal?: () => string | null }

/** Runs only from the migration runner while its BEGIN IMMEDIATE lock is held. */
export function applyRunFilesystemIdentityCutover(
  database: Database,
): RunFilesystemMigrationReport {
  const plans = discoverRunFilesystemIdentityMigration(database)
  const refusal = liveRunFilesystemMigrationRefusal(database)
  if (refusal) throw new Error(refusal)
  return applyRunFilesystemIdentityMigration(plans)
}

function defaultMigrateCommandActions(options: MigrateCommandOptions = {}): MigrateCommandActions {
  return {
    assertAuthority: () => {
      const refusal = (options.authorityRefusal ?? existingDatabaseMigrationRefusal)()
      if (refusal) throw new Error(refusal)
    },
    inFlightRuns: () =>
      existsSync(DB_PATH)
        ? withDatabaseForMigrationStep(async (database) => migrationInFlightRuns(database))
        : Promise.resolve([]),
    migrate: migrateDatabase,
    contracted: () =>
      existsSync(DB_PATH)
        ? withDatabaseForMigrationStep(async (database) =>
            migrationApplied(database, PROJECT_IDENTITY_CONTRACT_MIGRATION),
          )
        : Promise.resolve(false),
    fill: () => withDatabaseForMigrationStep((database) => fillProjectRecordIds(database)),
    backfill: backfillSpecSha,
    migrateCutover: () => {
      let files: RunFilesystemMigrationReport | undefined
      const migrated = migrateDatabase({
        beforeApply: {
          migration: RUN_FILESYSTEM_IDENTITY_CUTOVER,
          action(database) {
            files = applyRunFilesystemIdentityCutover(database)
          },
        },
      })
      return { ...migrated, files }
    },
  }
}

export async function migrateCommand(
  presentation: DatabaseCommandPresentation,
  actions?: MigrateCommandActions,
  options: MigrateCommandOptions = {},
): Promise<void> {
  actions ??= defaultMigrateCommandActions(options)
  actions.assertAuthority?.()
  const inFlight = await actions.inFlightRuns()
  presentation.log(`runs in flight before migration: ${inFlight.length}`)
  for (const run of inFlight) {
    presentation.log(`  ${run.name}: ${run.waiting ? 'waiting for host capacity' : run.status}`)
  }
  const alreadyContracted = await actions.contracted()
  const before = alreadyContracted
    ? { path: '', versions: [] }
    : actions.migrate({ beforeMigration: PROJECT_IDENTITY_CONTRACT_MIGRATION })
  if (!alreadyContracted) await actions.fill()
  const beforeCutover = actions.migrate({
    beforeMigration: RUN_FILESYSTEM_IDENTITY_CUTOVER,
  })
  const after: {
    path: string
    versions: string[]
    files?: RunFilesystemMigrationReport
  } = actions.migrateCutover?.() ?? actions.migrate()
  const files = after.files
  if (files) {
    presentation.log(
      `run identity files: ${files.foldersRenamed} folders renamed, ${files.markersWritten} markers written, ${files.leaseFilesRenamed} leases renamed, ${files.retainedRefsRenamed} retained refs renamed, ${files.refGuardsRenamed} ref guards renamed, ${files.coordinatorLogsMoved} coordinator logs moved, ${files.leftAndReported.length} left and reported`,
    )
    for (const item of files.leftAndReported) presentation.log(`  left: ${item}`)
  }
  const migrated = {
    path: after.path,
    versions: [...before.versions, ...beforeCutover.versions, ...after.versions],
  }
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

export function reconcileCommand(id: string, presentation: DatabaseCommandPresentation): void {
  presentation.log(reconcileRun(id))
}
