import { randomUUID } from 'node:crypto'
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_NAME } from './brand.ts'
import { readOwnerOnlySecretFile } from './file-backed-secret-paths.ts'
import { decideKeyStore, KEYSTORE_ENV } from './key-store.ts'
import {
  deleteKeychainItem,
  keychainPlatform,
  readKeychainItem,
  readKeychainItemAsync,
  type SecurityRunner,
  writeKeychainItem,
} from './keychain.ts'
import { refusal, renderRefusal } from './refusal.ts'
import {
  ensureRecordSessionDirectory,
  recordSessionDirectory,
  recordSessionPath,
  recordSessionProbePath,
} from './state-directory.ts'

export type { SecurityRunner } from './keychain.ts'

const SERVICE = `${PLATFORM_NAME}-record-session`
const ACCOUNT = 'record'
const PROBE_ACCOUNT = 'record-probe'
const FILE_REMEDY = `set ${KEYSTORE_ENV}=file to keep the record session and the machine key in owner-only files`
let memoizedToken: string | null | undefined
let pendingToken: Promise<string | null> | null = null

function useFile(): boolean {
  return decideKeyStore(process.env[KEYSTORE_ENV]) === 'file'
}

function readFileToken(): string | null {
  return readOwnerOnlySecretFile(recordSessionPath(process.env), 'record session')?.trim() || null
}

function keychainFailureWithFileRemedy(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`${message}; or ${FILE_REMEDY}`)
}

function withKeychainRemedy<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (keychainPlatform() !== 'linux') throw error
    throw keychainFailureWithFileRemedy(error)
  }
}

export function readRecordSessionToken(runner?: SecurityRunner): string | null {
  if (memoizedToken !== undefined) return memoizedToken
  memoizedToken = useFile()
    ? readFileToken()
    : withKeychainRemedy(() => readKeychainItem(SERVICE, ACCOUNT, runner))
  return memoizedToken
}

export async function readRecordSessionTokenAsync(signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) throw signal.reason
  if (memoizedToken !== undefined) return memoizedToken
  if (pendingToken) return pendingToken
  if (useFile()) {
    memoizedToken = readFileToken()
    return memoizedToken
  }
  pendingToken = readKeychainItemAsync(SERVICE, ACCOUNT, signal)
    .catch((error) => {
      if (signal?.aborted || keychainPlatform() !== 'linux') throw error
      throw keychainFailureWithFileRemedy(error)
    })
    .then((token) => (memoizedToken = token))
    .finally(() => {
      pendingToken = null
    })
  return pendingToken
}

/** Forget the process copy so a later read observes a session changed by another process. */
export function forgetRecordSessionToken(): void {
  memoizedToken = undefined
  pendingToken = null
}

export function writeRecordSessionToken(token: string, runner?: SecurityRunner): void {
  if (!useFile()) {
    withKeychainRemedy(() => writeKeychainItem(SERVICE, ACCOUNT, token, runner))
    forgetRecordSessionToken()
    return
  }
  writeFileToken(recordSessionPath(process.env), token)
  forgetRecordSessionToken()
}

function writeFileToken(path: string, token: string): void {
  const directory = ensureRecordSessionDirectory(process.env)
  const temporaryPath = join(directory, `.session-${randomUUID()}`)
  try {
    writeFileSync(temporaryPath, token, { mode: 0o600, flag: 'wx' })
    chmodSync(temporaryPath, 0o600)
    renameSync(temporaryPath, path)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

/** Prove the selected record-session store is writable without touching the real session key. */
export function probeRecordSessionStore(runner?: SecurityRunner): void {
  const fileStore = useFile()
  try {
    if (fileStore) {
      const path = recordSessionProbePath(process.env)
      writeFileToken(path, randomUUID())
      rmSync(path, { force: true })
      return
    }
    let writeError: unknown
    try {
      writeKeychainItem(SERVICE, PROBE_ACCOUNT, randomUUID(), runner)
    } catch (error) {
      writeError = error
    }
    try {
      deleteKeychainItem(SERVICE, PROBE_ACCOUNT, runner)
    } catch (error) {
      if (!writeError) throw error
    }
    if (writeError) throw writeError
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const remedy = fileStore
      ? `make ${recordSessionDirectory(process.env)} a directory you own and can write`
      : FILE_REMEDY
    throw new Error(renderRefusal(refusal(message, { kind: 'edit', text: remedy })))
  }
}

export function clearRecordSessionToken(runner?: SecurityRunner): void {
  if (useFile()) {
    rmSync(recordSessionPath(process.env), { force: true })
    forgetRecordSessionToken()
    return
  }
  withKeychainRemedy(() => deleteKeychainItem(SERVICE, ACCOUNT, runner))
  forgetRecordSessionToken()
}
