// concern: setup-install-verify-runtime
/** Gathers install facts and applies the setup render before pure verification. */

import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { assetPath } from '../../../shared/install-root.ts'
import { recordSignInRemedy } from '../../../shared/record-remedies.ts'
import { runtimeAssetPath } from '../../../shared/runtime-assets.ts'
import { resolveRunsDirectory } from '../../../shared/state-directory.ts'
import { userCanonHomesFromEnvironment } from '../canon/user-canon-home-files.ts'
import {
  claudeHomeFromEnvironment,
  managedSettingsPaths,
  readSettingsJsonLenient,
  userLocalSettingsPath,
  userSettingsPath,
} from '../settings/settings-files.ts'
import {
  applyMachineSettings,
  type MachineSettingsApplyResult,
  settingsApplyDecision,
  settingsApplyLockSkipped,
} from '../settings/settings-machine-apply.ts'
import { PRODUCT_HOOKS, SCRIPT_FILES } from '../settings/settings-machine-hooks.ts'
import {
  type SetupInstallSettingsFileFact,
  type SetupInstallVerifyFacts,
  verifySetupInstall,
} from './setup-install-verify.ts'

export type SetupInstallVerifyAdapters = {
  applySettings?: () => Promise<MachineSettingsApplyResult[]>
  facts?: () => SetupInstallVerifyFacts
  prepareRuntime?: () => void
}

const SIGN_IN_FOLLOW_UP =
  `not signed in: user settings and user canon wait for sign-in; run ` +
  `${recordSignInRemedy('<email>').argv.join(' ')}, then re-run ${PLATFORM_SLUG} machine setup apply; ` +
  `install verification runs after sign-in`

function refusedSettingsMessage(refused: readonly MachineSettingsApplyResult[]): string {
  return refused
    .map(
      (result) =>
        `${result.target}: ${result.condition ? `${result.condition}; ` : ''}${result.detail ?? 'refused'}`,
    )
    .join('\n')
}

function readSettingsFact(
  path: string,
  kind: SetupInstallSettingsFileFact['kind'],
  required: boolean,
): SetupInstallSettingsFileFact {
  return { path, kind, required, ...readSettingsJsonLenient(path) }
}

function gatherSetupInstallVerifyFacts(
  environment: NodeJS.ProcessEnv = process.env,
): SetupInstallVerifyFacts {
  const installRoot = assetPath()
  const claudeHome = claudeHomeFromEnvironment(environment)
  const scriptFacts = SCRIPT_FILES.map((file) => {
    const path = runtimeAssetPath(`orchestrator/hooks/${file}`, environment)
    const exists = existsSync(path) && statSync(path).isFile()
    let executable = false
    if (exists) {
      try {
        accessSync(path, constants.X_OK)
        executable = true
      } catch {}
    }
    return { file, path, exists, executable }
  })
  const homes = userCanonHomesFromEnvironment(
    environment,
    resolveRunsDirectory(environment),
  ).filter((home) => home.installed)
  return {
    installRoot,
    hooks: PRODUCT_HOOKS,
    settingsFiles: [
      readSettingsFact(userSettingsPath(claudeHome), 'user', true),
      readSettingsFact(userLocalSettingsPath(claudeHome), 'local-machine', false),
      ...managedSettingsPaths(environment).map((path) => readSettingsFact(path, 'managed', false)),
    ],
    scripts: scriptFacts,
    canonEntries: homes.map((home) => {
      const path = join(home.path, home.mapping.entry.home)
      return { harness: home.mapping.harness, path, exists: existsSync(path) }
    }),
  }
}

function renderedChecks(
  checks: ReturnType<typeof verifySetupInstall>,
  includeFix: boolean,
): string {
  return checks
    .map(
      (check) =>
        `${check.name}: ${check.ok ? 'ok' : 'failed'}; ${check.detail}${includeFix ? `; fix: ${check.fix}` : ''}`,
    )
    .join('\n')
}

export async function applySetupInstallVerify(
  sessionPresent: boolean,
  adapters: SetupInstallVerifyAdapters = {},
): Promise<{
  status: 'applied' | 'unchanged' | 'follow-up'
  message: string
  condition?: 'waiting-for-sign-in'
}> {
  const prepareRuntime =
    adapters.prepareRuntime ?? (() => runtimeAssetPath('orchestrator/hooks/session-start.py'))
  prepareRuntime()
  const results = await (adapters.applySettings ?? (() => applyMachineSettings({ check: false })))()
  if (results.some(settingsApplyLockSkipped)) {
    throw new Error(
      `settings apply skipped: another settings apply holds the settings-apply lock; ` +
        `re-run \`${PLATFORM_SLUG} machine setup apply\` after it finishes`,
    )
  }
  const decision = settingsApplyDecision(sessionPresent, results)
  if (decision.action === 'refuse') throw new Error(refusedSettingsMessage(decision.refused))
  if (decision.action === 'wait-for-sign-in') {
    return {
      status: 'follow-up',
      message: SIGN_IN_FOLLOW_UP,
      condition: 'waiting-for-sign-in',
    }
  }
  const checks = verifySetupInstall((adapters.facts ?? gatherSetupInstallVerifyFacts)())
  if (checks.some((check) => !check.ok)) throw new Error(renderedChecks(checks, true))
  return {
    status: results.some((result) => result.changed) ? 'applied' : 'unchanged',
    message: renderedChecks(checks, false),
  }
}
