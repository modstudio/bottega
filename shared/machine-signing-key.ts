import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import { PLATFORM_NAME } from './brand.ts'
import {
  type ConfigEnvironment,
  machineSigningKeyFilePath,
  resolveConfigRoot,
  revokedMachineKeyDirectory,
} from './config-directory.ts'
import { readOwnerOnlySecretFile } from './file-backed-secret-paths.ts'
import {
  deleteKeychainItem,
  keychainPlatform,
  readKeychainItem,
  type SecurityRunner,
  writeKeychainItem,
} from './keychain.ts'
import { decideMachineKeyStore } from './machine-key-store.ts'

const SERVICE = `${PLATFORM_NAME}-machine-key`
const ACCOUNT = 'signing'

export type MachineSigningKeyPair = {
  privateKey: Uint8Array
  publicKey: Uint8Array
}

export function generateMachineSigningKeyPair(): MachineSigningKeyPair {
  const privateKey = ed25519.utils.randomSecretKey()
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) }
}

function decode(value: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(value.trim(), 'base64url'))
  if (Buffer.from(bytes).toString('base64url') !== value.trim() || bytes.length !== 32) {
    throw new Error('refusing machine signing key: stored value is malformed')
  }
  return bytes
}

function useFile(env: ConfigEnvironment): boolean {
  return decideMachineKeyStore(env, keychainPlatform()) === 'file'
}

export function readMachineSigningKey(
  env: ConfigEnvironment = process.env,
  runner?: SecurityRunner,
): MachineSigningKeyPair | null {
  let privateKey: Uint8Array
  if (useFile(env)) {
    const value = readOwnerOnlySecretFile(machineSigningKeyFilePath(env), 'machine signing key')
    if (value === null) return null
    privateKey = decode(value)
  } else {
    const value = readKeychainItem(SERVICE, ACCOUNT, runner)
    if (!value) return null
    privateKey = decode(value)
  }
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) }
}

export function writeMachineSigningKey(
  pair: MachineSigningKeyPair,
  env: ConfigEnvironment = process.env,
  runner?: SecurityRunner,
): void {
  if (readMachineSigningKey(env, runner))
    throw new Error('machine signing key already exists; refusing to overwrite it')
  const encoded = Buffer.from(pair.privateKey).toString('base64url')
  if (useFile(env)) {
    const root = resolveConfigRoot(env)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const path = machineSigningKeyFilePath(env)
    writeFileSync(path, `${encoded}\n`, { mode: 0o600, flag: 'wx' })
    chmodSync(path, 0o600)
    return
  }
  writeKeychainItem(SERVICE, ACCOUNT, encoded, runner)
  const stored = readMachineSigningKey(env, runner)
  if (!stored || !Buffer.from(stored.privateKey).equals(Buffer.from(pair.privateKey))) {
    throw new Error(
      'machine signing key verification failed: the stored key did not match the written key',
    )
  }
}

/** Moves a revoked signing identity aside under its X25519 key id and installs its replacement. */
export function replaceRevokedMachineSigningKey(
  revokedKeyId: string,
  pair: MachineSigningKeyPair,
  env: ConfigEnvironment = process.env,
  runner?: SecurityRunner,
): void {
  const existing = readMachineSigningKey(env, runner)
  if (!existing) throw new Error('machine signing key is not initialized; refusing to replace it')
  const encoded = Buffer.from(existing.privateKey).toString('base64url')
  if (useFile(env)) {
    const path = machineSigningKeyFilePath(env)
    const backupDirectory = revokedMachineKeyDirectory(env)
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 })
    chmodSync(backupDirectory, 0o700)
    const backupPath = join(backupDirectory, `${revokedKeyId}.signing`)
    renameSync(path, backupPath)
    chmodSync(backupPath, 0o600)
  } else {
    writeKeychainItem(SERVICE, `${ACCOUNT}.revoked-${revokedKeyId}`, encoded, runner)
    deleteKeychainItem(SERVICE, ACCOUNT, runner)
  }
  writeMachineSigningKey(pair, env, runner)
}
