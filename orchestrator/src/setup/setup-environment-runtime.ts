// concern: setup environment migration runtime
/** Wires the environment migration to stores and settings without leaking those adapters into setup policy. */

import { homedir } from 'node:os'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveStatePaths } from '../../../shared/state-directory.ts'
import {
  migrateLegacyEnvironmentSecrets,
  restoreLegacyEnvironmentSecrets,
} from '../config/config-service.ts'
import { linkedWorktreeDatabaseInitializationMessage } from '../database/database-location.ts'
import { checkpointAndCloseDatabase, DATABASE_RESOLUTION } from '../database/db.ts'
import {
  assertProjectSettingsMigrationWritable,
  migrateProjectSettingsText,
  restoreMigratedProjectRows,
} from '../project/project-commands.ts'
import { projects } from '../project/projects.ts'
import { currentRecordWriteDecision } from '../record/record-write-authority.ts'
import { isOrchWorkerProcess } from '../run/run-process.ts'
import {
  assertStoredSettingsEnvironmentMigration,
  migrateStoredSettingsEnvironmentNames,
  restoreStoredSettingsEnvironmentNames,
} from '../settings/settings-apply-commands.ts'
import { applyMachineSettings } from '../settings/settings-machine-apply.ts'
import {
  processEnvironmentNameMigration,
  replacementEnvironmentName,
} from './environment-name-migration.ts'
import type { SetupEnvironmentService } from './setup-apply.ts'
import {
  environmentMigrationMessage,
  environmentSettingsDecision,
  migrateOperatorEnvironment,
  type PreparedStateFileMigration,
  prepareStateFileMigration,
  restoreOperatorEnvironmentBackup,
  reversePreparedStateFileMigration,
} from './setup-environment.ts'

function assertStateFileRenameAllowed(action: 'migration' | 'restore'): void {
  if (DATABASE_RESOLUTION.linkedWorktreeBinary) {
    throw new Error(linkedWorktreeDatabaseInitializationMessage())
  }
  if (isOrchWorkerProcess(process.env, process.pid)) {
    throw new Error(
      `refusing setup ${action} from an orchestrator worker run; an operator must run ${PLATFORM_SLUG} machine setup ${action === 'migration' ? 'apply' : 'restore'}`,
    )
  }
}

/** Run before setup planning so no connection can open the destination first. */
export async function prepareSetupStateFileMigration(): Promise<PreparedStateFileMigration | null> {
  return prepareStateFileMigration(process.env, undefined, () =>
    assertStateFileRenameAllowed('migration'),
  )
}

export async function restoreSetupEnvironment(directory: string): Promise<void> {
  await restoreOperatorEnvironmentBackup(directory, {
    restoreSecrets: (migrations) =>
      migrations.length ? restoreLegacyEnvironmentSecrets(migrations) : Promise.resolve(),
    restoreSettings: (migrations) => restoreStoredSettingsEnvironmentNames(migrations),
    restoreRegister: restoreMigratedProjectRows,
    checkpointAndCloseStore: checkpointAndCloseDatabase,
    authorizeStateFileRename: () => assertStateFileRenameAllowed('restore'),
  })
}

export async function reverseSetupStateFileMigration(
  prepared: PreparedStateFileMigration,
): Promise<string> {
  return reversePreparedStateFileMigration(prepared, {
    authorizeStateFileRename: () => assertStateFileRenameAllowed('restore'),
    checkpointAndCloseStore: checkpointAndCloseDatabase,
  })
}

export function migrateProcessEnvironment(environment: Record<string, string | undefined>): number {
  const migration = processEnvironmentNameMigration(environment)
  if (migration.conflicts.length) {
    const names = migration.conflicts
      .map(({ legacyNames, replacementName }) =>
        legacyNames.length === 1
          ? `${legacyNames[0]} and ${replacementName}`
          : `${legacyNames.join(' and ')} both set ${replacementName}`,
      )
      .join(', ')
    throw new Error(
      `refusing environment migration: ${names} have different values in the running process; unset one name from each pair, then re-run ${PLATFORM_SLUG} machine setup apply`,
    )
  }
  for (const [name, value] of Object.entries(migration.set)) environment[name] = value
  for (const name of migration.unset) delete environment[name]
  return migration.unset.length
}

function restoreProcessEnvironment(
  environment: Record<string, string | undefined>,
  snapshot: Readonly<Record<string, string | undefined>>,
): void {
  for (const name of Object.keys(environment)) {
    if (!(name in snapshot)) delete environment[name]
  }
  for (const [name, value] of Object.entries(snapshot)) environment[name] = value
}

export async function withMigratedProcessEnvironment<T>(
  environment: Record<string, string | undefined>,
  migrate: (processNamesRenamed: number) => Promise<T>,
): Promise<T> {
  const snapshot = { ...environment }
  const processNamesRenamed = migrateProcessEnvironment(environment)
  try {
    return await migrate(processNamesRenamed)
  } catch (error) {
    restoreProcessEnvironment(environment, snapshot)
    throw error
  }
}

export const setupEnvironmentService: SetupEnvironmentService = {
  migrateEnvironment: async (preparedStateFileMigration) =>
    withMigratedProcessEnvironment(process.env, async (processNamesRenamed) => {
      const notes: string[] = []
      const home = homedir()
      const report = await migrateOperatorEnvironment(home, {
        backupRoot: resolveStatePaths(process.env).orchestratorDirectory,
        migrateSecrets: async (record) => {
          const authority = currentRecordWriteDecision()
          if (authority === 'local-authoritative') {
            notes.push('no hosted record: nothing to migrate')
            return []
          }
          if (authority === 'refused') {
            throw new Error(
              `sealed-secret environment migration did not run: configured record is unreachable; run ${PLATFORM_SLUG} record use <address>, then re-run ${PLATFORM_SLUG} machine setup apply`,
            )
          }
          return migrateLegacyEnvironmentSecrets(undefined, { migrated: record })
        },
        migrateRegister: () => migrateProjectSettingsText(environmentSettingsDecision),
        migrateSettings: () => migrateStoredSettingsEnvironmentNames(replacementEnvironmentName),
        preflight: async () => {
          await assertProjectSettingsMigrationWritable(environmentSettingsDecision)
          await assertStoredSettingsEnvironmentMigration(replacementEnvironmentName)
        },
        rerenderSettings: async () => {
          const results = await applyMachineSettings({ check: false })
          const refused = results.find((result) => result.outcome === 'refused')
          if (refused) throw new Error(refused.detail ?? `${refused.target} refused`)
          return results.some((result) => result.changed)
        },
        registerBackup: async () =>
          [...projects(), ...projects({ retired: true })]
            .filter((project) => environmentSettingsDecision(project.settings).names.length > 0)
            .map((project) => project),
        notes: () => notes,
        processNamesRenamed,
        preparedStateFileMigration,
      })
      const message = environmentMigrationMessage(report)
      const changed =
        report.processNamesRenamed > 0 ||
        report.files.length > 0 ||
        report.secrets.length > 0 ||
        report.register.length > 0 ||
        report.settings.length > 0 ||
        report.backupDirectory !== null ||
        report.notes.length > 0
      return {
        status: report.followUps.length ? 'follow-up' : changed ? 'applied' : 'unchanged',
        message,
      }
    }),
}
