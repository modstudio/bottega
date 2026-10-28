// concern: database
/** Owns database maintenance command behavior. Must not know CLI grammar. */

import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { fillProjectRecordIds } from '../project/project-record-identity.ts'
import {
  formatMigrationInFlightRun,
  type MigrationInFlightRun,
  migrationInFlightRuns,
} from '../run/migration-in-flight-runs.ts'
import { reconcileRun } from '../run/run-artifacts.ts'
import {
  backfillSpecSha,
  DB_PATH,
  migrateDatabase,
  migrationAuthorityRefusal,
  openReadOnlyDatabase,
  tryWriteContention,
  withDatabaseForMigrationStep,
  withSynchronousDatabaseForMigrationStep,
} from './db.ts'
import {
  clearMigrationDrain,
  migrationDrainForUpdate,
  setMigrationDrain,
} from './migration-drain.ts'
import { decideMigrationDrain } from './migration-drain-decision.ts'
import { claimMigrationWindow, clearMigrationWindow } from './migration-window.ts'
import { migrationWindow } from './migration-window-state.ts'
import { migrationApplied, migrationJournal, storeJournalPosition } from './migrations.ts'
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
  migrationDecision?(): ReturnType<typeof decideMigrationDrain>
  withMigrationFence?(migration: string, action: () => Promise<void>): Promise<void>
  withMigrationWindow?(action: () => Promise<void>): Promise<void>
  recordOverride?(reason: string): void
}

const PROJECT_IDENTITY_CONTRACT_MIGRATION = '0115_project_identity_contract'
const RUN_FILESYSTEM_IDENTITY_CUTOVER = '0121_run_filesystem_identity_cutover'

type MigrateCommandOptions = {
  authorityRefusal?: () => string | null
  forceInFlight?: string
  fromOperator?: boolean
}

export const MIGRATION_DRAIN_REFUSAL_EXIT_CODE = 75

export class MigrationDrainRefusalError extends Error {
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

async function withAdditiveMigrationWindow(action: () => Promise<void>): Promise<void> {
  if (!existsSync(DB_PATH)) return action()
  const state = withSynchronousDatabaseForMigrationStep((database) => {
    const journal = migrationJournal()
    const position = storeJournalPosition(database, journal)
    if (position.state === 'pending-not-found') {
      throw new Error(`migration journal does not contain pending migration ${position.migration}`)
    }
    const migration = journal[position.index]?.tag ?? null
    if (!migration) return { inherited: false, marked: false }
    const active = migrationWindow(database)
    if (active?.migration === migration && active.pid === process.ppid) {
      return { inherited: true, marked: true }
    }
    claimMigrationWindow(database, migration)
    return { inherited: false, marked: true }
  })
  try {
    await action()
  } finally {
    if (state.marked && !state.inherited) {
      withSynchronousDatabaseForMigrationStep((database) => clearMigrationWindow(database))
    }
  }
}

function defaultMigrateCommandActions(options: MigrateCommandOptions = {}): MigrateCommandActions {
  return {
    assertAuthority: () => {
      const refusal = (options.authorityRefusal ?? migrationAuthorityRefusal)()
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
    migrationDecision: () => {
      if (!existsSync(DB_PATH)) return { action: 'apply-now' }
      const database = openReadOnlyDatabase()
      try {
        const journal = migrationJournal()
        const position = storeJournalPosition(database, journal)
        if (position.state === 'pending-not-found') {
          throw new Error(
            `migration journal does not contain pending migration ${position.migration}`,
          )
        }
        return decideMigrationDrain({
          journal,
          storeVersion: position.index,
        })
      } finally {
        database.close()
      }
    },
    withMigrationFence: async (migration, action) => {
      const inherited = withSynchronousDatabaseForMigrationStep((database) => {
        const active = migrationDrainForUpdate(database)
        if (
          active?.phase === 'migrating' &&
          active.migration === migration &&
          active.pid === process.ppid
        ) {
          return true
        }
        if (active) {
          throw new Error(
            `migration drain is already active for ${active.migration} (holder pid ${active.pid})`,
          )
        }
        setMigrationDrain(database, migration, 'migrating')
        return false
      })
      try {
        await action()
      } finally {
        if (!inherited) {
          withSynchronousDatabaseForMigrationStep((database) => clearMigrationDrain(database))
        }
      }
    },
    withMigrationWindow: withAdditiveMigrationWindow,
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
  if (!input.decision || input.decision.action === 'apply-now' || input.runs.length === 0) return
  const names = input.runs.map(formatMigrationInFlightRun).join(', ')
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
  for (const run of runs) presentation.log(`  ${formatMigrationInFlightRun(run)}`)
}

async function performMigration(
  presentation: DatabaseCommandPresentation,
  actions: MigrateCommandActions,
  decision: ReturnType<typeof decideMigrationDrain> | undefined,
  overrideReason: string | undefined,
): Promise<void> {
  const inFlight = await actions.inFlightRuns()
  reportInFlightRuns(presentation, inFlight)
  assertInFlightMigrationAllowed({
    decision,
    runs: inFlight,
    force: overrideReason !== undefined,
    presentation,
  })
  if (overrideReason !== undefined && decision?.action === 'fence' && inFlight.length > 0) {
    actions.recordOverride?.(overrideReason)
  }
  await finishMigration(presentation, actions)
}

export async function migrateCommand(
  presentation: DatabaseCommandPresentation,
  actions?: MigrateCommandActions,
  options: MigrateCommandOptions = {},
): Promise<void> {
  const overrideReason = validateMigrationOverride(options)
  actions ??= defaultMigrateCommandActions(options)
  actions.assertAuthority?.()
  const decision = actions.migrationDecision?.()
  if (decision?.action === 'fence' && actions.withMigrationFence) {
    await actions.withMigrationFence(decision.migration, () =>
      performMigration(presentation, actions!, decision, overrideReason),
    )
    return
  }
  if (decision?.action === 'apply-now' && actions.withMigrationWindow) {
    await actions.withMigrationWindow(() =>
      performMigration(presentation, actions!, decision, overrideReason),
    )
    return
  }
  await performMigration(presentation, actions, decision, overrideReason)
}

async function finishMigration(
  presentation: DatabaseCommandPresentation,
  actions: MigrateCommandActions,
): Promise<void> {
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
