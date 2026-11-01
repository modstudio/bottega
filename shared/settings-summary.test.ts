import { expect, test } from 'bun:test'
import { summarizeSettings } from './settings-summary.ts'

test('settings summaries keep text outside secret-shaped spans', () => {
  expect(
    summarizeSettings({
      permissions: { allow: ['prefix token=fixture-value suffix'] },
      hooks: { PreToolUse: [{ matcher: 'before token=fixture-value after' }] },
    }),
  ).toMatchObject({
    permissions: { allow: ['prefix [withheld: assignment] suffix'] },
    hooks: [{ matcher: 'before [withheld: assignment] after' }],
  })
})
