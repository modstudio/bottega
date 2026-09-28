import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applySettingsWrite,
  planSettingsWrite,
  restoreSettingsBackup,
  writeNewSettingsFileAtomically,
} from './settings-write.ts'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'settings-write-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('guarded settings write', () => {
  test('refuses content changed after planning', () => {
    const path = join(root, 'settings.json')
    writeFileSync(path, '{"old":true}\n', { mode: 0o640 })
    const plan = planSettingsWrite(path, '{"new":true}\n')
    writeFileSync(path, '{"other":true}\n')
    expect(() => applySettingsWrite(plan, { BOTTEGA_STATE_HOME: join(root, 'state') })).toThrow(
      /changed after planning/,
    )
    expect(readFileSync(path, 'utf8')).toBe('{"other":true}\n')
  })

  test('backs up before writing, preserves mode, and restores', () => {
    const path = join(root, 'settings.json')
    writeFileSync(path, '{"old":true}\n', { mode: 0o640 })
    const result = applySettingsWrite(planSettingsWrite(path, '{"new":true}\n'), {
      BOTTEGA_STATE_HOME: join(root, 'state'),
    })
    expect(readFileSync(result.backup!, 'utf8')).toBe('{"old":true}\n')
    expect(lstatSync(result.backup!).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).toBe('{"new":true}\n')
    expect(lstatSync(path).mode & 0o777).toBe(0o640)
    restoreSettingsBackup(path, result.backup!, { BOTTEGA_STATE_HOME: join(root, 'state') })
    expect(readFileSync(path, 'utf8')).toBe('{"old":true}\n')
  })

  test('refuses a symlink target', () => {
    const outside = join(root, 'outside.json')
    const target = join(root, 'settings.json')
    writeFileSync(outside, '{}\n')
    symlinkSync(outside, target)
    expect(() => planSettingsWrite(target, '{"new":true}\n')).toThrow(/symbolic links/)
    expect(readFileSync(outside, 'utf8')).toBe('{}\n')
  })

  test('refuses restore after later edits unless forced and refuses stray files', () => {
    const path = join(root, 'settings.json')
    const environment = { BOTTEGA_STATE_HOME: join(root, 'state') }
    writeFileSync(path, '{"old":true}\n')
    const result = applySettingsWrite(planSettingsWrite(path, '{"new":true}\n'), environment)
    writeFileSync(path, '{"later":true}\n')
    expect(() => restoreSettingsBackup(path, result.backup!, environment)).toThrow(
      /changed after the backup was installed.*--force/s,
    )
    restoreSettingsBackup(path, result.backup!, environment, true)
    expect(readFileSync(path, 'utf8')).toBe('{"old":true}\n')

    const stray = join(root, 'stray.bak')
    writeFileSync(stray, '{}\n')
    expect(() => restoreSettingsBackup(path, stray, environment, true)).toThrow(
      /not a recognized settings backup/,
    )
  })

  test('an unchanged write creates no backup and pre-existing backup directory becomes private', () => {
    const path = join(root, 'settings.json')
    const state = join(root, 'state')
    const backups = join(state, 'orchestrator', 'settings-backups')
    mkdirSync(backups, { recursive: true, mode: 0o755 })
    chmodSync(backups, 0o755)
    writeFileSync(path, '{}\n')
    expect(
      applySettingsWrite(planSettingsWrite(path, '{}\n'), { BOTTEGA_STATE_HOME: state }),
    ).toEqual({ backup: null, written: false })
    expect(readdirSync(backups)).toEqual([])
    expect(lstatSync(backups).mode & 0o777).toBe(0o700)
  })

  test('an absent-path write never replaces a file created at its publish boundary', () => {
    const path = join(root, 'new-settings.json')
    expect(() =>
      writeNewSettingsFileAtomically(path, '{"new":true}\n', 0o640, undefined, () => {
        writeFileSync(path, '{"concurrent":true}\n')
      }),
    ).toThrow(/changed after planning/)
    expect(readFileSync(path, 'utf8')).toBe('{"concurrent":true}\n')
  })

  test('keeps only the newest configured number of complete backups', () => {
    const path = join(root, 'settings.json')
    const state = join(root, 'state')
    const environment = { BOTTEGA_STATE_HOME: state }
    writeFileSync(path, '0\n')
    for (let index = 1; index <= 12; index++) {
      applySettingsWrite(planSettingsWrite(path, `${index}\n`), environment)
    }
    const backups = join(state, 'orchestrator', 'settings-backups')
    expect(readdirSync(backups).filter((name) => name.endsWith('.bak'))).toHaveLength(10)
    expect(readdirSync(backups).filter((name) => name.endsWith('.bak.json'))).toHaveLength(10)
  })
})
