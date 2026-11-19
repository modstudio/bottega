// concern: setup-install-verify-runtime
/** Gathers install facts and applies the setup render before pure verification. */

import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { assetPath } from '../../../shared/install-root.ts'
import { resolveRunsDirectory } from '../../../shared/state-directory.ts'
import { userCanonHomesFromEnvironment } from '../canon/user-canon-home-files.ts'
import {
  claudeHomeFromEnvironment,
  userLocalSettingsPath,
  userSettingsPath,
} from '../settings/settings-files.ts'
import {
  applyMachineSettings,
  type MachineSettingsApplyResult,
  settingsApplyLockSkipped,
} from '../settings/settings-machine-apply.ts'
import { hookScriptPath, PRODUCT_HOOKS, SCRIPT_FILES } from '../settings/settings-machine-hooks.ts'
import {
  type SetupInstallSettingsFileFact,
  type SetupInstallVerifyFacts,
  verifySetupInstall,
} from './setup-install-verify.ts'

export type SetupInstallVerifyAdapters = {
  applySettings?: () => Promise<MachineSettingsApplyResult[]>
  facts?: () => SetupInstallVerifyFacts
}

function readSettingsFact(
  path: string,
  kind: SetupInstallSettingsFileFact['kind'],
  required: boolean,
): SetupInstallSettingsFileFact {
  if (!existsSync(path)) return { path, kind, required, state: 'absent' }
  try {
    return {
      path,
      kind,
      required,
      state: 'readable',
      settings: JSON.parse(readFileSync(path, 'utf8')),
    }
  } catch (error) {
    return {
      path,
      kind,
      required,
      state: 'unreadable',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

function managedSettingsPaths(environment: NodeJS.ProcessEnv): string[] {
  if (process.platform === 'darwin') {
    return ['/Library/Application Support/ClaudeCode/managed-settings.json']
  }
  if (process.platform === 'win32') {
    const programFiles = environment.ProgramFiles
    return programFiles ? [join(programFiles, 'ClaudeCode', 'managed-settings.json')] : []
  }
  return ['/etc/claude-code/managed-settings.json']
}

function gatherSetupInstallVerifyFacts(
  environment: NodeJS.ProcessEnv = process.env,
): SetupInstallVerifyFacts {
  const installRoot = assetPath()
  const claudeHome = claudeHomeFromEnvironment(environment)
  const scriptFacts = SCRIPT_FILES.map((file) => {
    const path = hookScriptPath(installRoot, file)
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
  adapters: SetupInstallVerifyAdapters = {},
): Promise<{ status: 'applied' | 'unchanged'; message: string }> {
  const results = await (adapters.applySettings ?? (() => applyMachineSettings({ check: false })))()
  if (results.some(settingsApplyLockSkipped)) {
    throw new Error(
      `settings apply skipped: another settings apply holds the settings-apply lock; ` +
        `re-run \`${PLATFORM_SLUG} machine setup apply\` after it finishes`,
    )
  }
  const refused = results.filter((result) => result.outcome === 'refused')
  if (refused.length > 0) {
    throw new Error(
      refused
        .map(
          (result) =>
            `${result.target}: ${result.condition ? `${result.condition}; ` : ''}${result.detail ?? 'refused'}`,
        )
        .join('\n'),
    )
  }
  const checks = verifySetupInstall((adapters.facts ?? gatherSetupInstallVerifyFacts)())
  if (checks.some((check) => !check.ok)) throw new Error(renderedChecks(checks, true))
  return {
    status: results.some((result) => result.changed) ? 'applied' : 'unchanged',
    message: renderedChecks(checks, false),
  }
}
