import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { RECORD_SIGN_IN_REMEDY } from '../../../shared/record-remedies.ts'
import {
  type MachineSettingsApplyResult,
  SETTINGS_APPLY_LOCK_TARGET,
  settingsApplyDecision,
} from '../settings/settings-machine-apply.ts'
import {
  PRODUCT_HOOKS,
  SCRIPT_FILES,
  withMachineProductHooks,
} from '../settings/settings-machine-hooks.ts'
import type { SetupInstallVerifyFacts } from './setup-install-verify.ts'
import { applySetupInstallVerify } from './setup-install-verify-runtime.ts'

const current: MachineSettingsApplyResult[] = [
  { target: 'settings user', outcome: 'current', changed: false },
]

function facts(): SetupInstallVerifyFacts {
  const installRoot = `/installed/${PLATFORM_SLUG}`
  const scriptPath = (file: string) => join(installRoot, 'orchestrator', 'hooks', file)
  return {
    installRoot,
    hooks: PRODUCT_HOOKS,
    settingsFiles: [
      {
        path: '/home/operator/.claude/settings.json',
        kind: 'user',
        required: true,
        state: 'readable',
        settings: withMachineProductHooks(
          { permissions: {}, hooks: {} },
          '/state/orchestrator.db',
          'on',
          {
            executable: join(installRoot, 'bin', PLATFORM_SLUG),
            scriptPath,
          },
        ).settings,
      },
    ],
    scripts: SCRIPT_FILES.map((file) => ({
      file,
      path: scriptPath(file),
      assetRoot: installRoot,
      exists: true,
      readable: true,
      executable: true,
    })),
    canonEntries: [{ harness: 'claude', path: '/home/operator/.claude/CLAUDE.md', exists: true }],
  }
}

function removeRenderedHook(input: SetupInstallVerifyFacts, script: string): void {
  const settings = input.settingsFiles[0]!.settings as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
  }
  for (const groups of Object.values(settings.hooks)) {
    for (const group of groups) {
      group.hooks = group.hooks.filter((handler) => !handler.command.includes(`/${script}`))
    }
  }
}

test('rendered and verified install settings succeed with every named check', async () => {
  const result = await applySetupInstallVerify(true, {
    applySettings: async () => current,
    facts,
  })
  expect(result.status).toBe('unchanged')
  expect(result.message).toContain('hooks-present: ok')
  expect(result.message).toContain('user-canon-present: ok')
})

test('the rendered success fixture fails when one product hook is removed', async () => {
  const input = facts()
  removeRenderedHook(input, 'git-guard.py')
  await expect(
    applySetupInstallVerify(true, { applySettings: async () => current, facts: () => input }),
  ).rejects.toThrow('hooks-present: failed')
})

test('a settings-row refusal names its target, condition, and row remedy', async () => {
  await expect(
    applySetupInstallVerify(true, {
      applySettings: async () => [
        {
          target: 'settings /home/operator/.claude/settings.json',
          outcome: 'refused',
          condition: 'no-settings-row',
          detail:
            'refusing settings render: no settings row for user\n' +
            `cleared by: ${PLATFORM_SLUG} doc set --scope settings --user --slug settings`,
          changed: false,
        },
      ],
      facts,
    }),
  ).rejects.toThrow('no-settings-row')
})

test('signed-out settings decisions stay follow-ups after a grok canon home is installed', async () => {
  const missingSettings: MachineSettingsApplyResult = {
    target: 'settings /home/operator/.claude/settings.json',
    outcome: 'refused',
    condition: 'no-settings-row',
    detail: 'refusing settings render: no settings row for user',
    changed: false,
  }
  const emptyGrokCanon: MachineSettingsApplyResult = {
    target: 'canon grok /home/operator/.grok',
    outcome: 'refused',
    condition: 'empty-user-canon-store',
    detail: 'refusing user canon hydration: empty store',
    changed: false,
  }
  const first = settingsApplyDecision(false, [missingSettings])
  const second = settingsApplyDecision(false, [missingSettings, emptyGrokCanon])
  expect(first.action).toBe('wait-for-sign-in')
  expect(second.action).toBe(first.action)

  let runtimePrepared = false
  const applied = await applySetupInstallVerify(false, {
    prepareRuntime: () => {
      runtimePrepared = true
    },
    applySettings: async () => [missingSettings, emptyGrokCanon],
    facts: () => {
      throw new Error('signed-out follow-up must not gather verification facts')
    },
  })
  expect(runtimePrepared).toBe(true)
  expect(applied).toEqual({
    status: 'follow-up',
    condition: 'waiting-for-sign-in',
    message:
      `not signed in: user settings and user canon wait for sign-in; run ` +
      `${PLATFORM_SLUG} record sign-in --email <email>, then re-run ${PLATFORM_SLUG} machine setup apply; ` +
      `install verification runs after sign-in`,
  })
})

test('signed-in settings and canon refusals still refuse', () => {
  expect(
    settingsApplyDecision(true, [
      {
        target: 'settings user',
        outcome: 'refused',
        condition: 'no-settings-row',
        changed: false,
      },
      {
        target: 'canon grok',
        outcome: 'refused',
        condition: 'empty-user-canon-store',
        changed: false,
      },
    ]),
  ).toMatchObject({ action: 'refuse' })
})

test('an absent hook after render refuses naming hooks-present', async () => {
  const input = facts()
  removeRenderedHook(input, 'stop-summary.py')
  await expect(
    applySetupInstallVerify(true, { applySettings: async () => current, facts: () => input }),
  ).rejects.toThrow('hooks-present: failed')
})

test('a missing record session refuses with the sign-in remedy', async () => {
  await expect(
    applySetupInstallVerify(false, {
      applySettings: async () => {
        throw new Error(RECORD_SIGN_IN_REMEDY)
      },
      facts,
    }),
  ).rejects.toThrow(`${PLATFORM_SLUG} record sign-in`)
})

test('a skipped settings render refuses without verifying', async () => {
  let gathered = false
  await expect(
    applySetupInstallVerify(false, {
      applySettings: async () => [
        { target: SETTINGS_APPLY_LOCK_TARGET, outcome: 'skipped', changed: false },
      ],
      facts: () => {
        gathered = true
        return facts()
      },
    }),
  ).rejects.toThrow('another settings apply holds the settings-apply lock')
  expect(gathered).toBe(false)
})

test('a skipped registered project does not prevent verification', async () => {
  const result = await applySetupInstallVerify(true, {
    applySettings: async () => [
      ...current,
      {
        target: 'project /projects/missing',
        outcome: 'skipped',
        detail: 'missing path',
        changed: false,
      },
    ],
    facts,
  })
  expect(result.status).toBe('unchanged')
  expect(result.message).toContain('hooks-present: ok')
})
