import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SETTINGS_PARSE_REFUSAL } from './settings.ts'
import {
  claudeHomeFromEnvironment,
  managedSettingsPaths,
  readLocalPermissionLists,
  readSettingsFile,
  readSettingsJsonLenient,
  SETTINGS_JSON_INVALID_DETAIL,
  userSettingsPath,
} from './settings-files.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'settings-home-'))
  roots.push(home)
  return claudeHomeFromEnvironment({ HOME: home })
}

describe('settings files', () => {
  test('locates managed settings for each supported platform', () => {
    expect(managedSettingsPaths({}, 'darwin')).toEqual([
      '/Library/Application Support/ClaudeCode/managed-settings.json',
    ])
    expect(managedSettingsPaths({ ProgramFiles: 'C:\\Program Files' }, 'win32')).toEqual([
      join('C:\\Program Files', 'ClaudeCode', 'managed-settings.json'),
    ])
    expect(managedSettingsPaths({}, 'linux')).toEqual(['/etc/claude-code/managed-settings.json'])
  })

  test('lenient JSON reads distinguish absent, readable, and unreadable settings', () => {
    const claudeHome = fixtureHome()
    mkdirSync(claudeHome, { recursive: true })
    const path = userSettingsPath(claudeHome)
    expect(readSettingsJsonLenient(path)).toEqual({ state: 'absent' })
    writeFileSync(path, '{"disableAllHooks":true}')
    expect(readSettingsJsonLenient(path)).toEqual({
      state: 'readable',
      settings: { disableAllHooks: true },
    })
    writeFileSync(path, '{')
    expect(readSettingsJsonLenient(path)).toMatchObject({ state: 'unreadable' })
  })

  test('lenient JSON reads do not expose malformed settings content', () => {
    const claudeHome = fixtureHome()
    mkdirSync(claudeHome, { recursive: true })
    const path = userSettingsPath(claudeHome)
    writeFileSync(path, '{"env":{"K":ghp_ABCdef1234567890xyz}}')

    const result = readSettingsJsonLenient(path)

    expect(result).toEqual({ state: 'unreadable', detail: SETTINGS_JSON_INVALID_DETAIL })
    expect(result.state === 'unreadable' ? result.detail : '').not.toContain('ghp_')
  })

  test('reads owned keys from a fixture file and ignores the rest', () => {
    const claudeHome = fixtureHome()
    mkdirSync(claudeHome, { recursive: true })
    writeFileSync(
      userSettingsPath(claudeHome),
      `${JSON.stringify(
        {
          env: { SECRET: 'no' },
          permissions: { allow: ['a'], ask: ['b'] },
          hooks: {},
        },
        null,
        2,
      )}\n`,
    )
    expect(readSettingsFile(userSettingsPath(claudeHome)).owned).toEqual({
      permissions: { allow: ['a'], ask: ['b'] },
      hooks: {},
      envKeys: [],
    })
  })

  test('refuses unparseable JSON without reading other keys', () => {
    const claudeHome = fixtureHome()
    mkdirSync(claudeHome, { recursive: true })
    writeFileSync(userSettingsPath(claudeHome), '{')
    expect(() => readSettingsFile(userSettingsPath(claudeHome))).toThrow(SETTINGS_PARSE_REFUSAL)
  })

  test('refuses a symlink', () => {
    const claudeHome = fixtureHome()
    mkdirSync(claudeHome, { recursive: true })
    const outside = join(dirname(claudeHome), 'outside.json')
    writeFileSync(outside, '{"permissions":{"allow":["secret"]}}')
    symlinkSync(outside, userSettingsPath(claudeHome))
    expect(() => readSettingsFile(userSettingsPath(claudeHome))).toThrow(/symbolic link/)
  })

  test('missing local file yields empty adoption lists', () => {
    expect(readLocalPermissionLists(join(fixtureHome(), 'settings.local.json'))).toEqual({
      allow: [],
      ask: [],
      deny: [],
    })
  })
})
