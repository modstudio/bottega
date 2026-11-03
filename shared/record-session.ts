import { randomUUID } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_NAME } from './brand.ts'
import { decideKeyStore } from './key-store.ts'
import {
  deleteKeychainItem,
  keychainPlatform,
  readKeychainItem,
  readKeychainItemAsync,
  type SecurityRunner,
  writeKeychainItem,
} from './keychain.ts'
import { ensureRecordSessionDirectory, recordSessionPath } from './state-directory.ts'

export type { SecurityRunner } from './keychain.ts'

const SERVICE = `${PLATFORM_NAME}-record-session`
const ACCOUNT = 'record'
const KEYSTORE_ENV = 'BOTTEGA_KEYSTORE'
const FILE_REMEDY = 'or set BOTTEGA_KEYSTORE=file to keep the record session in an owner-only file'

function useFile(): boolean {
  return decideKeyStore(process.env[KEYSTORE_ENV]) === 'file'
}

function readFileToken(): string | null {
  const path = recordSessionPath(process.env)
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error(`refusing record session ${path}: file permissions must be no wider than 0600`)
  }
  return readFileSync(path, 'utf8')
}

function withKeychainRemedy<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (keychainPlatform() !== 'linux') throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}; ${FILE_REMEDY}`)
  }
}

export function readRecordSessionToken(runner?: SecurityRunner): string | null {
  if (useFile()) return readFileToken()
  return withKeychainRemedy(() => readKeychainItem(SERVICE, ACCOUNT, runner))
}

export async function readRecordSessionTokenAsync(signal?: AbortSignal): Promise<string | null> {
  if (useFile()) {
    if (signal?.aborted) throw signal.reason
    return readFileToken()
  }
  try {
    return await readKeychainItemAsync(SERVICE, ACCOUNT, signal)
  } catch (error) {
    if (signal?.aborted || keychainPlatform() !== 'linux') throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}; ${FILE_REMEDY}`)
  }
}

export function writeRecordSessionToken(token: string, runner?: SecurityRunner): void {
  if (!useFile()) {
    withKeychainRemedy(() => writeKeychainItem(SERVICE, ACCOUNT, token, runner))
    return
  }
  const directory = ensureRecordSessionDirectory(process.env)
  const path = recordSessionPath(process.env)
  const temporaryPath = join(directory, `.session-${randomUUID()}`)
  try {
    writeFileSync(temporaryPath, token, { mode: 0o600, flag: 'wx' })
    chmodSync(temporaryPath, 0o600)
    renameSync(temporaryPath, path)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

export function clearRecordSessionToken(runner?: SecurityRunner): void {
  if (useFile()) {
    rmSync(recordSessionPath(process.env), { force: true })
    return
  }
  withKeychainRemedy(() => deleteKeychainItem(SERVICE, ACCOUNT, runner))
}
