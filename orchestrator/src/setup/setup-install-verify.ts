// concern: setup-install-verify
/** Decides whether setup-rendered hooks and user canon landed. Pure: adapters supply plain facts. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  commandNamesHookScript,
  type ProductHookDeclaration,
} from '../settings/settings-machine-hooks.ts'

export type SetupInstallSettingsFileFact = {
  path: string
  kind: 'user' | 'local-machine' | 'managed'
  required: boolean
  state: 'absent' | 'unreadable' | 'readable'
  detail?: string
  settings?: unknown
}

export type SetupInstallVerifyFacts = {
  installRoot: string
  hooks: readonly ProductHookDeclaration[]
  settingsFiles: SetupInstallSettingsFileFact[]
  scripts: Array<{ file: string; path: string; exists: boolean; executable: boolean }>
  canonEntries: Array<{ harness: string; path: string; exists: boolean }>
}

export type SetupInstallVerifyCheck = {
  name:
    | 'hooks-present'
    | 'hook-scripts-executable'
    | 'hooks-not-disabled'
    | 'board-hooks-present'
    | 'user-canon-present'
  ok: boolean
  detail: string
  fix: string
}

type HookHandler = { command: string }

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function userSettings(facts: SetupInstallVerifyFacts): SetupInstallSettingsFileFact | undefined {
  return facts.settingsFiles.find((file) => file.kind === 'user')
}

function handlersFor(settings: unknown, declaration: ProductHookDeclaration): HookHandler[] {
  const groups = object(object(settings)?.hooks)?.[declaration.event]
  if (!Array.isArray(groups)) return []
  return groups.flatMap((candidate) => {
    const group = object(candidate)
    const matcher = typeof group?.matcher === 'string' ? group.matcher : undefined
    if (matcher !== declaration.matcher || !Array.isArray(group?.hooks)) return []
    return group.hooks.flatMap((candidateHandler) => {
      const handler = object(candidateHandler)
      return typeof handler?.command === 'string' ? [{ command: handler.command }] : []
    })
  })
}

function missingHooks(
  facts: SetupInstallVerifyFacts,
  declarations: readonly ProductHookDeclaration[],
): string[] {
  const file = userSettings(facts)
  if (file?.state !== 'readable') {
    return [`${file?.path ?? 'Claude user settings'} is ${file?.state ?? 'absent'}`]
  }
  const available = new Map<string, number>()
  for (const declaration of declarations) {
    const key = `${declaration.event}\0${declaration.matcher ?? ''}\0${declaration.script}`
    if (available.has(key)) continue
    available.set(
      key,
      handlersFor(file.settings, declaration).filter((handler) =>
        commandNamesHookScript(handler.command, declaration.script, facts.installRoot),
      ).length,
    )
  }
  const missing: string[] = []
  for (const declaration of declarations) {
    const key = `${declaration.event}\0${declaration.matcher ?? ''}\0${declaration.script}`
    const count = available.get(key) ?? 0
    if (count > 0) {
      available.set(key, count - 1)
      continue
    }
    missing.push(
      `${declaration.event} ${declaration.matcher ?? '(no matcher)'} ${declaration.script}`,
    )
  }
  return missing
}

function hookCheck(
  facts: SetupInstallVerifyFacts,
  name: 'hooks-present' | 'board-hooks-present',
  declarations: readonly ProductHookDeclaration[],
): SetupInstallVerifyCheck {
  const missing = missingHooks(facts, declarations)
  return {
    name,
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `${declarations.length} hook declarations present`
        : `missing: ${missing.join(', ')}`,
    fix: `re-run \`${PLATFORM_SLUG} machine setup apply\` from this installation`,
  }
}

function executableCheck(facts: SetupInstallVerifyFacts): SetupInstallVerifyCheck {
  const failed = facts.scripts.filter((script) => !script.exists || !script.executable)
  return {
    name: 'hook-scripts-executable',
    ok: failed.length === 0,
    detail:
      failed.length === 0
        ? `${facts.scripts.length} hook scripts exist and are executable`
        : failed
            .map((script) => `${script.path} ${script.exists ? 'is not executable' : 'is absent'}`)
            .join(', '),
    fix: `restore executable hook scripts in this installation, then re-run \`${PLATFORM_SLUG} machine setup apply\``,
  }
}

function hooksEnabledCheck(facts: SetupInstallVerifyFacts): SetupInstallVerifyCheck {
  const failures = facts.settingsFiles.flatMap((file) => {
    if (file.state === 'absent' && !file.required) return []
    if (file.state !== 'readable')
      return [`${file.path} is ${file.state}${file.detail ? ` (${file.detail})` : ''}`]
    const settings = object(file.settings)
    if (!settings) return [`${file.path} does not contain a settings object`]
    const disabled = settings.disableAllHooks === true
    const managedOnly = file.kind === 'managed' && settings.allowManagedHooksOnly === true
    return [
      ...(disabled ? [`${file.path} sets disableAllHooks=true`] : []),
      ...(managedOnly ? [`${file.path} sets allowManagedHooksOnly=true`] : []),
    ]
  })
  return {
    name: 'hooks-not-disabled',
    ok: failures.length === 0,
    detail:
      failures.length === 0
        ? 'no readable settings file disables product hooks'
        : failures.join(', '),
    fix: `make the named settings file readable and remove the hook-disabling setting, then re-run \`${PLATFORM_SLUG} machine setup apply\``,
  }
}

function canonCheck(facts: SetupInstallVerifyFacts): SetupInstallVerifyCheck {
  const missing = facts.canonEntries.filter((entry) => !entry.exists)
  return {
    name: 'user-canon-present',
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `${facts.canonEntries.length} installed harness canon entries present`
        : `missing: ${missing.map((entry) => `${entry.harness} ${entry.path}`).join(', ')}`,
    fix:
      `run \`${PLATFORM_SLUG} record push\`, then re-run \`${PLATFORM_SLUG} machine setup apply\`; ` +
      `if this user's canon lacks the AGENTS.md entry row, create it with ` +
      `\`${PLATFORM_SLUG} doc set --scope canon --user\``,
  }
}

export function verifySetupInstall(facts: SetupInstallVerifyFacts): SetupInstallVerifyCheck[] {
  return [
    hookCheck(facts, 'hooks-present', facts.hooks),
    executableCheck(facts),
    hooksEnabledCheck(facts),
    hookCheck(
      facts,
      'board-hooks-present',
      facts.hooks.filter((hook) => hook.boardEnvironment === true),
    ),
    canonCheck(facts),
  ]
}
