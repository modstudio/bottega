import { expect, test } from 'bun:test'
import type { OwnedSettings } from './stored-settings.ts'
import { summarizeSettings } from './settings-summary.ts'

test('settings summaries keep text outside secret-shaped spans', () => {
  expect(
    summarizeSettings({
      permissions: { allow: ['prefix token=fixture-value suffix'] },
      hooks: { PreToolUse: [{ matcher: 'before token=fixture-value after' }] },
      options: { subagentHooks: 'on' },
    }),
  ).toMatchObject({
    permissions: { allow: ['prefix [withheld: assignment]'] },
    hooks: [{ matcher: 'before [withheld: assignment]' }],
    options: { subagentHooks: 'on' },
  })
})

test('settings summaries redact secret-shaped future option strings', () => {
  const credential = ['ghp_', 'testtoken', '0'.repeat(28)].join('')
  const summary = summarizeSettings({
    permissions: {},
    hooks: {},
    options: { futureCredential: `prefix ${credential} suffix` },
  } as unknown as OwnedSettings)
  expect(summary.options).toEqual({
    futureCredential: 'prefix [withheld: provider-prefix] suffix',
  })
  expect(JSON.stringify(summary)).not.toContain(credential)
})
