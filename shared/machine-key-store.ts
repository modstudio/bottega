import { createPrivateKey, createPublicKey } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, type Stats, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_NAME, PLATFORM_SLUG } from './brand.ts'
import { type ConfigEnvironment, resolveConfigRoot } from './config-directory.ts'
import { readKeychainItem, type SecurityRunner, writeKeychainItem } from './keychain.ts'
import { machineKeyId } from './machine-key-id.ts'
import type { MachineKeyPair } from './secret-envelope.ts'

const SERVICE = `${PLATFORM_NAME}-machine-key`
const ACCOUNT = 'machine'
const KEYSTORE_ENV = `${PLATFORM_SLUG.toUpperCase()}_KEYSTORE`
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

function filePath(env: ConfigEnvironment): string {
  return join(resolveConfigRoot(env), 'machine-key')
}

function publicFromPrivate(privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== 32) throw new Error('refusing machine key: private key is malformed')
  try {
    const key = createPrivateKey({
      key: Buffer.concat([PKCS8_PREFIX, privateKey]),
      format: 'der',
      type: 'pkcs8',
    })
    const der = createPublicKey(key).export({ format: 'der', type: 'spki' })
    return new Uint8Array(der.subarray(der.length - 32))
  } catch {
    throw new Error('refusing machine key: private key is malformed')
  }
}

function decode(value: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(value.trim(), 'base64url'))
  if (Buffer.from(bytes).toString('base64url') !== value.trim() || bytes.length !== 32) {
    throw new Error('refusing machine key: stored value is malformed')
  }
  return bytes
}

function useFile(env: ConfigEnvironment): boolean {
  const requested = env[KEYSTORE_ENV]
  if (requested !== undefined && requested !== 'file') {
    throw new Error(`${KEYSTORE_ENV} must be 'file' when set`)
  }
  return requested === 'file' || process.platform !== 'darwin'
}

export function readMachineKey(
  env: ConfigEnvironment = process.env,
  runner?: SecurityRunner,
): MachineKeyPair | null {
  let privateKey: Uint8Array
  if (useFile(env)) {
    const path = filePath(env)
    let stat: Stats
    try {
      stat = statSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error(`refusing machine key ${path}: file permissions must be no wider than 0600`)
    }
    privateKey = decode(readFileSync(path, 'utf8'))
  } else {
    const value = readKeychainItem(SERVICE, ACCOUNT, runner)
    if (!value) return null
    privateKey = decode(value)
  }
  return { privateKey, publicKey: publicFromPrivate(privateKey) }
}

export function writeMachineKey(
  pair: MachineKeyPair,
  env: ConfigEnvironment = process.env,
  runner?: SecurityRunner,
): void {
  if (readMachineKey(env, runner))
    throw new Error('machine key already exists; refusing to overwrite it')
  const encoded = Buffer.from(pair.privateKey).toString('base64url')
  if (useFile(env)) {
    const root = resolveConfigRoot(env)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const path = filePath(env)
    writeFileSync(path, `${encoded}\n`, { mode: 0o600, flag: 'wx' })
    chmodSync(path, 0o600)
    return
  }
  writeKeychainItem(SERVICE, ACCOUNT, encoded, runner)
  const stored = readMachineKey(env, runner)
  if (!stored || !Buffer.from(stored.privateKey).equals(Buffer.from(pair.privateKey))) {
    throw new Error('security add-generic-password verification failed: stored key did not match')
  }
}

export async function machineKeyInfo(pair: MachineKeyPair) {
  return { ...pair, keyId: await machineKeyId(pair.publicKey) }
}
