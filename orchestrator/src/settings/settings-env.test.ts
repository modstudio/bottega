import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mergeSettingsEnv,
  readSettingsEnv,
  selectedSettingsEnvironment,
  settingsEnvironmentFromJson,
  writeSettingsEnv,
} from './settings-env.ts'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'settings-env-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('settings secrets file', () => {
  test('imports values without returning them and refuses a conflict', () => {
    const source = join(root, 'settings.json')
    const secrets = join(root, 'settings.env')
    const sentinel = 'sentinel-value-that-must-never-be-printed'
    writeFileSync(source, JSON.stringify({ env: { BETA: 'two', ALPHA: sentinel } }))
    const imported = settingsEnvironmentFromJson(source)
    expect(mergeSettingsEnv(secrets, imported, false)).toEqual({
      names: ['ALPHA', 'BETA'],
      added: 2,
      present: 0,
    })
    expect(readSettingsEnv(secrets).get('ALPHA')).toBe(sentinel)
    expect(() => mergeSettingsEnv(secrets, { ALPHA: 'different' }, false)).toThrow(
      /ALPHA already has a different value/,
    )
  })

  test('refuses group or other permissions', () => {
    const secrets = join(root, 'settings.env')
    writeFileSync(secrets, 'ALPHA="one"\n', { mode: 0o644 })
    chmodSync(secrets, 0o644)
    expect(() => readSettingsEnv(secrets)).toThrow(/permits group or other access/)
  })

  test('selects exactly the requested names and refuses a missing name', () => {
    const secrets = join(root, 'settings.env')
    writeFileSync(secrets, 'ALPHA="one"\nBETA="two"\n', { mode: 0o600 })
    expect(selectedSettingsEnvironment(secrets, ['BETA'])).toEqual({ BETA: 'two' })
    expect(() => selectedSettingsEnvironment(secrets, ['MISSING'])).toThrow(
      new RegExp(`MISSING is missing from ${secrets.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    )
  })

  test('parses comments after quoted values and comment-only unquoted values', () => {
    const secrets = join(root, 'settings.env')
    writeFileSync(
      secrets,
      'DOUBLE="one # retained" # comment\nSINGLE=\'two # retained\' # comment\nEMPTY= # comment\nONLY=#comment\n',
      { mode: 0o600 },
    )
    expect(readSettingsEnv(secrets)).toEqual(
      new Map([
        ['DOUBLE', 'one # retained'],
        ['SINGLE', 'two # retained'],
        ['EMPTY', ''],
        ['ONLY', ''],
      ]),
    )
  })

  test('a malformed JSON refusal never contains source values', () => {
    const source = join(root, 'settings.json')
    const sentinel = 'sentinel-malformed-value-that-must-not-escape'
    writeFileSync(source, `{"env":{"TOKEN":"${sentinel}"}`)
    let message = ''
    try {
      settingsEnvironmentFromJson(source)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('cannot parse JSON')
    expect(message).not.toContain(sentinel)
  })

  test('an interrupted replacement preserves the old file', () => {
    const secrets = join(root, 'settings.env')
    writeFileSync(secrets, 'OLD="preserved"\n', { mode: 0o600 })
    expect(() =>
      writeSettingsEnv(secrets, new Map([['NEW', 'replacement']]), () => {
        throw new Error('injected interruption')
      }),
    ).toThrow(/injected interruption/)
    expect(readFileSync(secrets, 'utf8')).toBe('OLD="preserved"\n')
  })

  test('refuses to replace a hard-linked secrets file', () => {
    const secrets = join(root, 'settings.env')
    const link = join(root, 'settings.env.link')
    writeFileSync(secrets, 'OLD="preserved"\n', { mode: 0o600 })
    linkSync(secrets, link)
    expect(() => writeSettingsEnv(secrets, new Map([['NEW', 'replacement']]))).toThrow(
      /hard links are not allowed/,
    )
    expect(readFileSync(link, 'utf8')).toBe('OLD="preserved"\n')
  })
})
