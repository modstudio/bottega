import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SETTINGS_PARSE_REFUSAL } from './settings.ts'
import {
  claudeHomeFromEnvironment,
  readLocalPermissionLists,
  readSettingsFile,
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
