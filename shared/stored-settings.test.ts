import { expect, test } from 'bun:test'
import {
  parseStoredSettingsRow,
  STORED_SETTINGS_REMEDY,
  StoredSettingsRowError,
} from './stored-settings.ts'

test('stored settings rows default legacy environment fields and name invalid keys', () => {
  expect(parseStoredSettingsRow(JSON.stringify({ permissions: {}, hooks: {} }))).toEqual({
    permissions: {},
    hooks: {},
    env: {},
    envKeys: [],
  })

  try {
    parseStoredSettingsRow(
      JSON.stringify({ permissions: {}, hooks: {}, envKeys: [], undeclared: true }),
    )
    throw new Error('expected the stored settings row to be refused')
  } catch (error) {
    expect(error).toBeInstanceOf(StoredSettingsRowError)
    expect(error).toMatchObject({ reason: 'shape', path: 'undeclared' })
    expect((error as Error).message).toBe(
      `stored settings row has an invalid shape at "undeclared"\n${STORED_SETTINGS_REMEDY}`,
    )
  }

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
