import { expect, test } from 'bun:test'
import {
  parseStoredSettingsRow,
  STORED_SETTINGS_REMEDY,
  summarizeSettings,
} from './settings-summary.ts'

test('settings summaries keep text outside secret-shaped spans', () => {
  expect(
    summarizeSettings({
      permissions: { allow: ['prefix token=fixture-value suffix'] },
      hooks: { PreToolUse: [{ matcher: 'before token=fixture-value after' }] },
    }),
  ).toMatchObject({
    permissions: { allow: ['prefix [withheld: assignment]'] },
    hooks: [{ matcher: 'before [withheld: assignment]' }],
  })
})

test('stored settings rows default legacy environment fields and name invalid keys', () => {
  expect(parseStoredSettingsRow(JSON.stringify({ permissions: {}, hooks: {} }))).toEqual({
    permissions: {},
    hooks: {},
    env: {},
    envKeys: [],
  })
  expect(() =>
    parseStoredSettingsRow(
      JSON.stringify({ permissions: {}, hooks: {}, envKeys: [], undeclared: true }),
    ),
  ).toThrow(`stored settings row has an invalid shape at "undeclared"\n${STORED_SETTINGS_REMEDY}`)
  expect(() => parseStoredSettingsRow('{')).toThrow(
    `stored settings row cannot parse JSON\n${STORED_SETTINGS_REMEDY}`,
  )
})
