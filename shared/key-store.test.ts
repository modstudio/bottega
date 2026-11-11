import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KEYSTORE_ENV } from './key-store-constants.ts'
import { decideKeyStore } from './key-store.ts'
import { setMachineValue } from './machine-config.ts'

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

function environment(value?: string): Record<string, string | undefined> {
  const root = mkdtempSync(join(tmpdir(), 'key-store-'))
  temporary.push(root)
  return { BOTTEGA_CONFIG_HOME: root, ...(value === undefined ? {} : { [KEYSTORE_ENV]: value }) }
}

test('resolves the keystore from environment, machine config, then the default', () => {
  const env = environment()
  expect(decideKeyStore(env)).toBe('keychain')

  setMachineValue('machine.keystore', 'file', env)
  expect(decideKeyStore(env)).toBe('file')
  expect(decideKeyStore({ ...env, [KEYSTORE_ENV]: 'keychain' })).toBe('keychain')
})

test('refuses an invalid keystore value with the key and allowed values', () => {
  expect(() => decideKeyStore(environment('vault'))).toThrow(
    'key machine.keystore must be one of keychain, file',
  )
})
