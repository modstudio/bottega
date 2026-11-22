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
  scripts: Array<{
    file: string
    path: string
    assetRoot: string
    exists: boolean
    readable: boolean
    executable: boolean
  }>
  canonEntries: Array<{ harness: string; path: string; exists: boolean }>
}

export type SetupProductHookFact = {
  event: ProductHookDeclaration['event']
  matcher: string | null
  script: ProductHookDeclaration['script']
  state: 'present' | 'missing' | 'drifted'
}

export type SetupInstallVerifyCheck = {
  name:
    | 'hooks-present'
    | 'hook-scripts-accessible'
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

export function classifySetupProductHooks(input: {
  settings: unknown
  readable: boolean
  declarations: readonly ProductHookDeclaration[]
  assetRoot(script: ProductHookDeclaration['script']): string | undefined
}): SetupProductHookFact[] {
  const pools = new Map<string, HookHandler[]>()
  return input.declarations.map((declaration) => {
    const key = `${declaration.event}\0${declaration.matcher ?? ''}`
    let handlers = pools.get(key)
    if (!handlers) {
      handlers = input.readable ? handlersFor(input.settings, declaration) : []
      pools.set(key, handlers)
    }
    const assetRoot = input.assetRoot(declaration.script)
    const present = handlers.findIndex((handler) =>
      commandNamesHookScript(handler.command, declaration.script, assetRoot),
    )
    let state: SetupProductHookFact['state'] = 'missing'
    if (present >= 0) {
      handlers.splice(present, 1)
      state = 'present'
    } else {
      const drifted = handlers.findIndex((handler) =>
        commandNamesHookScript(handler.command, declaration.script),
      )
      if (drifted >= 0) {
        handlers.splice(drifted, 1)
        state = 'drifted'
      }
    }
    return {
      event: declaration.event,
      matcher: declaration.matcher ?? null,
      script: declaration.script,
      state,
    }
  })
}

function setupProductHookFacts(facts: SetupInstallVerifyFacts): SetupProductHookFact[] {
  const file = userSettings(facts)
  return classifySetupProductHooks({
    settings: file?.settings,
    readable: file?.state === 'readable',
    declarations: facts.hooks,
    assetRoot: (script) =>
      facts.scripts.find((candidate) => candidate.file === script)?.assetRoot ?? facts.installRoot,
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
  const selected = new Set(declarations)
  return setupProductHookFacts(facts)
    .filter((hook, index) => selected.has(facts.hooks[index]!) && hook.state !== 'present')
    .map((hook) => `${hook.event} ${hook.matcher ?? '(no matcher)'} ${hook.script}`)
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

const LEADING_ENVIRONMENT_ASSIGNMENT =
  /^[A-Za-z_][A-Za-z0-9_]*=(?:'(?:[^']|'\\'')*'|"(?:[^"\\]|\\.)*"|(?:\\.|[^\s])+?)\s+/

function startsWithPython3AfterAssignments(command: string): boolean {
  let remainder = command.trimStart()
  while (true) {
    const assignment = remainder.match(LEADING_ENVIRONMENT_ASSIGNMENT)
    if (!assignment) return remainder === 'python3' || /^python3\s/.test(remainder)
    remainder = remainder.slice(assignment[0].length)
  }
}

function scriptInvocation(
  facts: SetupInstallVerifyFacts,
  script: SetupInstallVerifyFacts['scripts'][number],
): 'interpreter' | 'direct' {
  const file = userSettings(facts)
  if (file?.state !== 'readable') return 'direct'
  const commands = facts.hooks
    .filter((declaration) => declaration.script === script.file)
    .flatMap((declaration) => handlersFor(file.settings, declaration))
    .map((handler) => handler.command)
    .filter((command) => commandNamesHookScript(command, script.file, script.assetRoot))
  return commands.length > 0 && commands.every(startsWithPython3AfterAssignments)
    ? 'interpreter'
    : 'direct'
}

function scriptAccessCheck(facts: SetupInstallVerifyFacts): SetupInstallVerifyCheck {
  const failed = facts.scripts.filter(
    (script) =>
      !script.exists ||
      !script.readable ||
      (scriptInvocation(facts, script) === 'direct' && !script.executable),
  )
  return {
    name: 'hook-scripts-accessible',
    ok: failed.length === 0,
    detail:
      failed.length === 0
        ? `${facts.scripts.length} hook scripts have the access required by their invocation`
        : failed
            .map((script) => {
              if (!script.exists) return `${script.path} is absent`
              if (!script.readable) return `${script.path} is not readable`
              return `${script.path} is not executable for direct invocation`
            })
            .join(', '),
    fix: `restore hook script access in this installation, then re-run \`${PLATFORM_SLUG} machine setup apply\``,
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
    scriptAccessCheck(facts),
    hooksEnabledCheck(facts),
    hookCheck(
      facts,
      'board-hooks-present',
      facts.hooks.filter((hook) => hook.boardEnvironment === true),
    ),
    canonCheck(facts),
  ]
}
