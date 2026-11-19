import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  hookScriptPath,
  PRODUCT_HOOKS,
  SCRIPT_FILES,
  withMachineProductHooks,
} from '../settings/settings-machine-hooks.ts'
import {
  type SetupInstallVerifyCheck,
  type SetupInstallVerifyFacts,
  verifySetupInstall,
} from './setup-install-verify.ts'

const INSTALL = `/installed/${PLATFORM_SLUG}`

function facts(): SetupInstallVerifyFacts {
  const settings = withMachineProductHooks(
    { permissions: {}, hooks: {} },
    INSTALL,
    '/state/orchestrator.db',
    'on',
  ).settings
  return {
    installRoot: INSTALL,
    hooks: PRODUCT_HOOKS,
    settingsFiles: [
      {
        path: '/home/operator/.claude/settings.json',
        kind: 'user',
        required: true,
        state: 'readable',
        settings,
      },
      {
        path: '/home/operator/.claude/settings.local.json',
        kind: 'local-machine',
        required: false,
        state: 'absent',
      },
    ],
    scripts: SCRIPT_FILES.map((file) => ({
      file,
      path: hookScriptPath(INSTALL, file),
      exists: true,
      executable: true,
    })),
    canonEntries: [
      { harness: 'claude', path: '/home/operator/.claude/CLAUDE.md', exists: true },
      { harness: 'codex', path: '/home/operator/.codex/AGENTS.md', exists: true },
      { harness: 'grok', path: '/home/operator/.grok/AGENTS.md', exists: true },
    ],
  }
}

function check(
  result: SetupInstallVerifyCheck[],
  name: SetupInstallVerifyCheck['name'],
): SetupInstallVerifyCheck {
  return result.find((candidate) => candidate.name === name)!
}

function userSettings(input: SetupInstallVerifyFacts): Record<string, unknown> {
  return input.settingsFiles[0]!.settings as Record<string, unknown>
}

function removeHook(input: SetupInstallVerifyFacts, script: string): void {
  const hooks = userSettings(input).hooks as Record<
    string,
    Array<{ hooks: Array<{ command: string }> }>
  >
  for (const groups of Object.values(hooks)) {
    for (const group of groups) {
      group.hooks = group.hooks.filter((handler) => !handler.command.includes(`/${script}`))
    }
  }
}

test('all rendered facts pass every named install check', () => {
  expect(verifySetupInstall(facts()).every((candidate) => candidate.ok)).toBe(true)
})

test('a missing hook fails hooks-present', () => {
  const input = facts()
  removeHook(input, 'git-guard.py')
  expect(check(verifySetupInstall(input), 'hooks-present')).toMatchObject({ ok: false })
})

test('a hook pointing to another installation fails hooks-present', () => {
  const input = facts()
  const settings = userSettings(input)
  settings.hooks = JSON.parse(JSON.stringify(settings.hooks).replaceAll(INSTALL, '/other/install'))
  expect(check(verifySetupInstall(input), 'hooks-present')).toMatchObject({ ok: false })
})

test('a non-executable hook script fails hook-scripts-executable', () => {
  const input = facts()
  input.scripts[0]!.executable = false
  expect(check(verifySetupInstall(input), 'hook-scripts-executable')).toMatchObject({ ok: false })
})

test('disableAllHooks in user settings fails hooks-not-disabled', () => {
  const input = facts()
  userSettings(input).disableAllHooks = true
  expect(check(verifySetupInstall(input), 'hooks-not-disabled')).toMatchObject({ ok: false })
})

test('managed allowManagedHooksOnly fails hooks-not-disabled', () => {
  const input = facts()
  input.settingsFiles.push({
    path: '/etc/claude-code/managed-settings.json',
    kind: 'managed',
    required: false,
    state: 'readable',
    settings: { allowManagedHooksOnly: true },
  })
  expect(check(verifySetupInstall(input), 'hooks-not-disabled')).toMatchObject({ ok: false })
})

test('an unreadable managed settings file is named and fails hooks-not-disabled', () => {
  const input = facts()
  input.settingsFiles.push({
    path: '/etc/claude-code/managed-settings.json',
    kind: 'managed',
    required: false,
    state: 'unreadable',
    detail: 'permission denied',
  })
  const result = check(verifySetupInstall(input), 'hooks-not-disabled')
  expect(result.ok).toBe(false)
  expect(result.detail).toContain('/etc/claude-code/managed-settings.json')
})

test('a missing board hook fails the separately named board check', () => {
  const input = facts()
  removeHook(input, 'board-interrupt.py')
  expect(check(verifySetupInstall(input), 'board-hooks-present')).toMatchObject({ ok: false })
})

test('missing canon for an installed harness fails user-canon-present', () => {
  const input = facts()
  input.canonEntries[1]!.exists = false
  const result = check(verifySetupInstall(input), 'user-canon-present')
  expect(result.ok).toBe(false)
  expect(result.detail).toContain('codex')
  expect(result.fix).toContain(`${PLATFORM_SLUG} doc set --scope canon --user`)
})
