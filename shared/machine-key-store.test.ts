import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMachineKey, writeMachineKey } from './machine-key-store.ts'
import { generateMachineKeyPair } from './secret-envelope.ts'

const roots: string[] = []
const environment = () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-key-'))
  roots.push(root)
  return { BOTTEGA_CONFIG_HOME: root, BOTTEGA_KEYSTORE: 'file' }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('file machine key store', () => {
  test('creates mode 0600 and derives the original public key', async () => {
    const env = environment()
    const pair = await generateMachineKeyPair()
    writeMachineKey(pair, env)
    expect(statSync(join(env.BOTTEGA_CONFIG_HOME, 'machine-key')).mode & 0o777).toBe(0o600)
    expect(readMachineKey(env)).toEqual(pair)
  })

  test('refuses a file with wider permissions', async () => {
    const env = environment()
    writeMachineKey(await generateMachineKeyPair(), env)
    chmodSync(join(env.BOTTEGA_CONFIG_HOME, 'machine-key'), 0o644)
    expect(() => readMachineKey(env)).toThrow('file permissions must be no wider than 0600')
  })
})
