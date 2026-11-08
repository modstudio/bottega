// concern: setup environment migration runtime
/** Wires the environment migration to stores and settings without leaking those adapters into setup policy. */

import { homedir } from 'node:os'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { ConfigClientError, type ConfigClientErrorReason } from '../../../shared/config-client.ts'
import { type MachineLevel, setMachineValue } from '../../../shared/machine-config.ts'
import { RECORD_SIGN_IN_REMEDY } from '../../../shared/record-remedies.ts'
import { readRecordSessionToken } from '../../../shared/record-session.ts'
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
import { RecordApiRequestError } from '../record/record-api-client.ts'
import { currentRecordWriteDecision } from '../record/record-write-authority.ts'
import type { RecordWriteDecision } from '../record/record-write-decision.ts'
import { isOrchWorkerProcess } from '../run/run-process.ts'
import {
  assertStoredSettingsEnvironmentMigration,
  migrateStoredSettingsEnvironmentNames,
  restoreStoredSettingsEnvironmentNames,
} from '../settings/settings-apply-commands.ts'
import {
  applyMachineSettings,
  type MachineSettingsApplyResult,
} from '../settings/settings-machine-apply.ts'
import {
  processEnvironmentNameMigration,
  replacementEnvironmentName,
} from './environment-name-migration.ts'
import {
  environmentMigrationMessage,
  environmentSettingsDecision,
  migrateOperatorEnvironment,
  type PreparedStateFileMigration,
  prepareStateFileMigration,
  restoreOperatorEnvironmentBackup,
  reversePreparedStateFileMigration,
} from './setup-environment.ts'

export type EnvironmentRecordRenderResult =
  | { kind: 'not-run' }
  | { kind: 'rendered' }
  | {
      kind: 'config-error'
      reason: ConfigClientErrorReason
      status: number | null
      message: string
    }
  | {
      kind: 'record-error'
      errorKind: RecordApiRequestError['kind']
      status: number | null
      message: string
    }
  | { kind: 'error'; message: string }

export type EnvironmentRecordSessionDecision =
  | { action: 'local-authoritative' | 'hosted' | 'wait-for-sign-in' }
  | { action: 'refuse'; refusal: string }

export function environmentRecordSessionDecision(
  authority: RecordWriteDecision,
  sessionPresent: boolean,
  render: EnvironmentRecordRenderResult,
): EnvironmentRecordSessionDecision {
  if (authority.verdict === 'local-authoritative') return { action: 'local-authoritative' }
  if (authority.verdict === 'refused') return { action: 'refuse', refusal: authority.refusal }
  if (!sessionPresent) return { action: 'wait-for-sign-in' }
  if (render.kind === 'not-run' || render.kind === 'rendered') return { action: 'hosted' }
  if (
    (render.kind === 'config-error' &&
      (render.reason === 'not-configured' || render.status === 401)) ||
    (render.kind === 'record-error' && render.message.includes(RECORD_SIGN_IN_REMEDY))
  ) {
    return { action: 'wait-for-sign-in' }
  }
  return { action: 'refuse', refusal: render.message }
}

function recordRenderResult(error: unknown): EnvironmentRecordRenderResult {
  if (error instanceof ConfigClientError) {
    return {
      kind: 'config-error',
      reason: error.reason,
      status: error.status ?? null,
      message: error.message,
    }
  }
  if (error instanceof RecordApiRequestError) {
    return {
      kind: 'record-error',
      errorKind: error.kind,
      status: error.status,
      message: error.message,
    }
  }
  return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
}

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

export const setupEnvironmentService = {
  setMachineLevel: (level: MachineLevel) => setMachineValue('machine.level', level),
  setGlobalUse: (value: 'on' | 'off') => setMachineValue('machine.global_use', value),
  migrateEnvironment: async (
    preparedStateFileMigration?: PreparedStateFileMigration | null,
  ): Promise<{
    status: 'applied' | 'unchanged' | 'follow-up'
    message: string | null
  }> =>
    withMigratedProcessEnvironment(process.env, async (processNamesRenamed) => {
      const notes: string[] = []
      const authority = currentRecordWriteDecision()
      const sessionPresent = readRecordSessionToken() !== null
      let recordSessionUnavailable = false
      const waitForSignIn = () => {
        recordSessionUnavailable = true
        if (notes.length === 0) {
          notes.push(
            `not signed in: record secrets and user settings wait for sign-in; run ${PLATFORM_SLUG} record sign-in --email <email>`,
          )
        }
      }
      const initial = environmentRecordSessionDecision(authority, sessionPresent, {
        kind: 'not-run',
      })
      if (initial.action === 'wait-for-sign-in') waitForSignIn()
      const report = await migrateOperatorEnvironment(homedir(), {
        platform: process.platform,
        backupRoot: resolveStatePaths(process.env).orchestratorDirectory,
        migrateSecrets: async (record) => {
          if (initial.action === 'refuse') throw new Error(initial.refusal)
          if (initial.action === 'local-authoritative') {
            notes.push('no hosted record: nothing to migrate')
            return []
          }
          if (initial.action === 'wait-for-sign-in') return []
          try {
            return await migrateLegacyEnvironmentSecrets(undefined, { migrated: record })
          } catch (error) {
            const decision = environmentRecordSessionDecision(
              authority,
              sessionPresent,
              recordRenderResult(error),
            )
            if (decision.action === 'wait-for-sign-in') {
              waitForSignIn()
              return []
            }
            throw error
          }
        },
        migrateRegister: () => migrateProjectSettingsText(environmentSettingsDecision),
        migrateSettings: () => migrateStoredSettingsEnvironmentNames(replacementEnvironmentName),
        preflight: async () => {
          await assertProjectSettingsMigrationWritable(environmentSettingsDecision)
          await assertStoredSettingsEnvironmentMigration(replacementEnvironmentName)
        },
        rerenderSettings: async () => {
          if (recordSessionUnavailable) return false
          let results: MachineSettingsApplyResult[]
          try {
            results = await applyMachineSettings({ check: false })
          } catch (error) {
            const decision = environmentRecordSessionDecision(
              authority,
              sessionPresent,
              recordRenderResult(error),
            )
            if (decision.action === 'wait-for-sign-in') {
              waitForSignIn()
              return false
            }
            throw error
          }
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
        status:
          recordSessionUnavailable || report.followUps.length
            ? 'follow-up'
            : changed
              ? 'applied'
              : 'unchanged',
        message,
      }
    }),
}
