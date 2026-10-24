// concern: database
/** Owns database maintenance command behavior. Must not know CLI grammar. */

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { fillProjectRecordIds } from '../project/project-record-identity.ts'
import {
  type MigrationInFlightRun,
  migrationLeaseHoldingRuns,
} from '../run/migration-in-flight-runs.ts'
import { reconcileRun } from '../run/run-artifacts.ts'
import { existingDatabaseMigrationRefusal } from './database-location.ts'
import {
  backfillSpecSha,
  DB_PATH,
  migrateDatabase,
  tryWriteContention,
  withDatabaseForMigrationStep,
} from './db.ts'
import { decideMigrationDrain } from './migration-drain-decision.ts'
import { migrationApplied, migrationJournal, migrationState } from './migrations.ts'
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
  migrationDecision?(runs: MigrationInFlightRun[]): ReturnType<typeof decideMigrationDrain>
  recordOverride?(reason: string): void
}

const PROJECT_IDENTITY_CONTRACT_MIGRATION = '0115_project_identity_contract'
const RUN_FILESYSTEM_IDENTITY_CUTOVER = '0121_run_filesystem_identity_cutover'

type MigrateCommandOptions = {
  authorityRefusal?: () => string | null
  forceInFlight?: string
  fromOperator?: boolean
}

const MIGRATION_DRAIN_REFUSAL_EXIT_CODE = 75

class MigrationDrainRefusalError extends Error {
  readonly exitCode = MIGRATION_DRAIN_REFUSAL_EXIT_CODE
}

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
        ? withDatabaseForMigrationStep(async (database) => migrationLeaseHoldingRuns(database))
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
    migrationDecision: (runs) => {
      if (!existsSync(DB_PATH)) return { action: 'apply-now' }
      const database = new Database(DB_PATH, { readwrite: false, create: false })
      try {
        const state = migrationState(database)
        const journal = migrationJournal()
        const storeVersion = state.pending.length
          ? journal.findIndex((entry) => entry.tag === state.pending[0]!.tag)
          : journal.length
        return decideMigrationDrain({
          journal,
          storeVersion,
          runs,
          canDrain: false,
        })
      } finally {
        database.close()
      }
    },
    recordOverride: (reason) =>
      tryWriteContention({
        resourceKind: 'store',
        resourceKey: 'migration-drain',
        eventKind: 'invalidation',
        cause: `operator forced an in-flight migration: ${reason}`,
      }),
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

function assertInFlightMigrationAllowed(input: {
  decision: ReturnType<typeof decideMigrationDrain> | undefined
  runs: MigrationInFlightRun[]
  force: boolean
  presentation: DatabaseCommandPresentation
}): void {
  if (!input.decision || input.decision.action === 'apply-now') return
  const names = input.runs.map((run) => run.name).join(', ')
  if (!input.force) {
    throw new MigrationDrainRefusalError(
      `refusing non-additive migration while orchestrator runs are in flight: ${names}\n` +
        `cleared by: ${PLATFORM_SLUG} machine update`,
    )
  }
  input.presentation.log(`forcing migration; these orchestrator runs will fail: ${names}`)
}

function validateMigrationOverride(options: MigrateCommandOptions): string | undefined {
  const reason = options.forceInFlight
  if (reason === undefined) return undefined
  if (!reason.trim()) throw new Error('--force-in-flight requires a non-empty reason')
  if (!options.fromOperator) {
    throw new Error(
      'refusing migration override without operator attribution; rerun with --force-in-flight "<reason>" --from-operator',
    )
  }
  if (process.env.BOTTEGA_DEPTH !== undefined) {
    throw new Error('migration overrides are reserved for architect sessions; BOTTEGA_DEPTH is set')
  }
  return reason.trim()
}

function reportInFlightRuns(
  presentation: DatabaseCommandPresentation,
  runs: MigrationInFlightRun[],
): void {
  presentation.log(`runs in flight before migration: ${runs.length}`)
  for (const run of runs) {
    presentation.log(`  ${run.name}: ${run.waiting ? 'waiting for host capacity' : run.status}`)
  }
}

export async function migrateCommand(
  presentation: DatabaseCommandPresentation,
  actions?: MigrateCommandActions,
  options: MigrateCommandOptions = {},
): Promise<void> {
  const overrideReason = validateMigrationOverride(options)
  actions ??= defaultMigrateCommandActions(options)
  actions.assertAuthority?.()
  const inFlight = await actions.inFlightRuns()
  reportInFlightRuns(presentation, inFlight)
  const decision = actions.migrationDecision?.(inFlight)
  assertInFlightMigrationAllowed({
    decision,
    runs: inFlight,
    force: overrideReason !== undefined,
    presentation,
  })
  if (overrideReason !== undefined && decision && decision.action !== 'apply-now') {
    actions.recordOverride?.(overrideReason)
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
