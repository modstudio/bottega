import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  generateMachineSigningKeyPair,
  readMachineSigningKey,
  replaceRevokedMachineSigningKey,
  writeMachineSigningKey,
} from './machine-signing-key.ts'

const roots: string[] = []

function environment() {
  const root = mkdtempSync(join(tmpdir(), 'machine-signing-key-'))
  roots.push(root)
  return { BOTTEGA_CONFIG_HOME: root, BOTTEGA_KEYSTORE: 'file' }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('file signing key store round-trips and proves the public key matches', () => {
  const env = environment()
  const pair = generateMachineSigningKeyPair()
  writeMachineSigningKey(pair, env)

  const stored = readMachineSigningKey(env)!
  const message = new TextEncoder().encode('machine signing key proof')
  const signature = ed25519.sign(message, stored.privateKey)

  expect(statSync(join(env.BOTTEGA_CONFIG_HOME, 'machine-signing-key')).mode & 0o777).toBe(0o600)
  expect(stored).toEqual(pair)
  expect(ed25519.verify(signature, message, stored.publicKey)).toBe(true)
})

test('refuses to overwrite a stored signing key', () => {
  const env = environment()
  writeMachineSigningKey(generateMachineSigningKeyPair(), env)
  expect(() => writeMachineSigningKey(generateMachineSigningKeyPair(), env)).toThrow(
    'machine signing key already exists; refusing to overwrite it',
  )
})

test('refuses a malformed stored signing key', () => {
  const env = environment()
  writeFileSync(join(env.BOTTEGA_CONFIG_HOME, 'machine-signing-key'), 'malformed\n', {
    mode: 0o600,
  })
  expect(() => readMachineSigningKey(env)).toThrow(
    'refusing machine signing key: stored value is malformed',
  )
})

test('revoked replacement moves the old secret under the X25519 key id', () => {
  const env = environment()
  const oldPair = generateMachineSigningKeyPair()
  const replacement = generateMachineSigningKeyPair()
  writeMachineSigningKey(oldPair, env)

  replaceRevokedMachineSigningKey('revoked-key-id', replacement, env)

  expect(
    readFileSync(
      join(env.BOTTEGA_CONFIG_HOME, 'machine-key-revoked', 'revoked-key-id.signing'),
      'utf8',
    ).trim(),
  ).toBe(Buffer.from(oldPair.privateKey).toString('base64url'))
  expect(readMachineSigningKey(env)).toEqual(replacement)
})
