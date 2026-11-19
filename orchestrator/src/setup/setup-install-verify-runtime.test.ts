import { expect, test } from 'bun:test'
import { RECORD_SIGN_IN_REMEDY } from '../../../shared/record-remedies.ts'
import type { MachineSettingsApplyResult } from '../settings/settings-machine-apply.ts'
import { applySetupInstallVerify } from './setup-install-verify-runtime.ts'
import type { SetupInstallVerifyFacts } from './setup-install-verify.ts'

const current: MachineSettingsApplyResult[] = [
  { target: 'settings user', outcome: 'current', changed: false },
]

function facts(): SetupInstallVerifyFacts {
  return {
    installRoot: '/installed/bottega',
    hooks: [],
    settingsFiles: [
      {
        path: '/home/operator/.claude/settings.json',
        kind: 'user',
        required: true,
        state: 'readable',
        settings: {},
      },
    ],
    scripts: [],
    canonEntries: [],
  }
}

test('rendered and verified install settings succeed with every named check', async () => {
  const result = await applySetupInstallVerify({
    applySettings: async () => current,
    facts,
  })
  expect(result.status).toBe('unchanged')
  expect(result.message).toContain('hooks-present: ok')
  expect(result.message).toContain('user-canon-present: ok')
})

test('a settings-row refusal names its target, condition, and row remedy', async () => {
  await expect(
    applySetupInstallVerify({
      applySettings: async () => [
        {
          target: 'settings /home/operator/.claude/settings.json',
          outcome: 'refused',
          condition: 'no-settings-row',
          detail:
            'refusing settings render: no settings row for user\n' +
            'cleared by: bottega doc set --scope settings --user --slug settings',
          changed: false,
        },
      ],
      facts,
    }),
  ).rejects.toThrow('no-settings-row')
})

test('an absent hook after render refuses naming hooks-present', async () => {
  const input = facts()
  input.hooks = [{ event: 'Stop', script: 'stop-summary.py', boardEnvironment: true }]
  await expect(
    applySetupInstallVerify({ applySettings: async () => current, facts: () => input }),
  ).rejects.toThrow('hooks-present: failed')
})

test('a missing record session refuses with the sign-in remedy', async () => {
  await expect(
    applySetupInstallVerify({
      applySettings: async () => {
        throw new Error(RECORD_SIGN_IN_REMEDY)
      },
      facts,
    }),
  ).rejects.toThrow('bottega record sign-in')
})
