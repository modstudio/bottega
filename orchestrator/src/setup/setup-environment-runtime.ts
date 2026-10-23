// concern: setup environment migration runtime
/** Wires the environment migration to stores and settings without leaking those adapters into setup policy. */

import { homedir } from 'node:os'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveStatePaths } from '../../../shared/state-directory.ts'
import {
  migrateLegacyEnvironmentSecrets,
  restoreLegacyEnvironmentSecrets,
} from '../config/config-service.ts'
import {
  assertProjectSettingsMigrationWritable,
  migrateProjectSettingsText,
  restoreMigratedProjectRows,
} from '../project/project-commands.ts'
import { projects } from '../project/projects.ts'
import { currentRecordWriteDecision } from '../record/record-write-authority.ts'
import {
  assertStoredSettingsEnvironmentMigration,
  migrateStoredSettingsEnvironmentNames,
  restoreStoredSettingsEnvironmentNames,
} from '../settings/settings-apply-commands.ts'
import { applyMachineSettings } from '../settings/settings-machine-apply.ts'
import { replacementEnvironmentName } from './environment-name-migration.ts'
import type { SetupEnvironmentService } from './setup-apply.ts'
import {
  environmentMigrationMessage,
  environmentSettingsDecision,
  migrateOperatorEnvironment,
  restoreOperatorEnvironmentBackup,
} from './setup-environment.ts'

export async function restoreSetupEnvironment(directory: string): Promise<void> {
  await restoreOperatorEnvironmentBackup(directory, {
    restoreSecrets: (migrations) =>
      migrations.length ? restoreLegacyEnvironmentSecrets(migrations) : Promise.resolve(),
    restoreSettings: (migrations) => restoreStoredSettingsEnvironmentNames(migrations),
    restoreRegister: restoreMigratedProjectRows,
  })
}

export const setupEnvironmentService: SetupEnvironmentService = {
  migrateEnvironment: async () => {
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
    })
    const message = environmentMigrationMessage(report)
    if (report.followUps.length) throw new Error(message ?? 'applied, follow-up required')
    return message
  },
}
