import { expect, test } from 'bun:test'
import {
  OWNED_SETTINGS_SCHEMA,
  parseStoredSettingsRow,
  STORED_SETTINGS_OPTIONS_REMEDY,
  STORED_SETTINGS_REMEDY,
  StoredSettingsRowError,
} from './stored-settings.ts'

test('stored settings rows default legacy fields and tolerate newer top-level keys', () => {
  expect(OWNED_SETTINGS_SCHEMA.safeParse({ permissions: {}, hooks: {} }).success).toBeFalse()

  expect(parseStoredSettingsRow(JSON.stringify({ permissions: {}, hooks: {} }))).toEqual({
    permissions: {},
    hooks: {},
    env: {},
    envKeys: [],
  })

  expect(
    parseStoredSettingsRow(
      JSON.stringify({
        permissions: {},
        hooks: {},
        autoMode: { allow: ['Bash(git status)'], futureList: ['x'] },
        options: { subagentHooks: 'on', futureOption: 1 },
        envKeys: [],
        futureKey: true,
      }),
    ),
  ).toEqual({
    permissions: {},
    hooks: {},
    autoMode: { allow: ['Bash(git status)'] },
    options: { subagentHooks: 'on' },
    env: {},
    envKeys: [],
  })

  expect(() =>
    parseStoredSettingsRow(
      JSON.stringify({ permissions: {}, hooks: {}, options: { subagentHooks: 'warn' } }),
    ),
  ).toThrow(
    new RegExp(`options\\.subagentHooks.*cleared by: ${STORED_SETTINGS_OPTIONS_REMEDY}`, 's'),
  )

  try {
    parseStoredSettingsRow('{')
    throw new Error('expected the stored settings row to be refused')
  } catch (error) {
    expect(error).toBeInstanceOf(StoredSettingsRowError)
    expect(error).toMatchObject({ reason: 'json' })
    expect((error as Error).message).toBe(
      `stored settings row cannot parse JSON\n${STORED_SETTINGS_REMEDY}`,
    )
  }
})
