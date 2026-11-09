import { randomUUID } from 'node:crypto'
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_NAME } from './brand.ts'
import { readOwnerOnlySecretFile } from './file-backed-secret-paths.ts'
import { decideKeyStore, KEYSTORE_ENV } from './key-store.ts'
import {
  type AsyncSecurityRunner,
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

export type { AsyncSecurityRunner, SecurityRunner } from './keychain.ts'

const SERVICE = `${PLATFORM_NAME}-record-session`
const ACCOUNT = 'record'
const PROBE_ACCOUNT = 'record-probe'
const FILE_REMEDY = `set ${KEYSTORE_ENV}=file to keep the record session and the machine key in owner-only files`
let memoizedToken: string | null | undefined
let pendingToken: Promise<string | null> | null = null
let tokenGeneration = 0

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
  if (runner)
    return useFile()
      ? readFileToken()
      : withKeychainRemedy(() => readKeychainItem(SERVICE, ACCOUNT, runner))
  if (memoizedToken !== undefined) return memoizedToken
  memoizedToken = useFile()
    ? readFileToken()
    : withKeychainRemedy(() => readKeychainItem(SERVICE, ACCOUNT, runner))
  return memoizedToken
}

export async function readRecordSessionTokenAsync(
  signal?: AbortSignal,
  runner?: AsyncSecurityRunner,
): Promise<string | null> {
  if (signal?.aborted) throw signal.reason
  if (memoizedToken !== undefined) return memoizedToken
  if (pendingToken) return raceCallerSignal(pendingToken, signal)
  if (useFile()) {
    memoizedToken = readFileToken()
    return memoizedToken
  }
  const generation = tokenGeneration
  const read = readKeychainItemAsync(SERVICE, ACCOUNT, undefined, runner)
    .catch((error) => {
      if (keychainPlatform() !== 'linux') throw error
      throw keychainFailureWithFileRemedy(error)
    })
    .then((token) => {
      if (generation === tokenGeneration) memoizedToken = token
      return token
    })
    .finally(() => {
      if (pendingToken === read) pendingToken = null
    })
  pendingToken = read
  return raceCallerSignal(read, signal)
}

function raceCallerSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

type StoredRecordSessionSendOptions = {
  signal?: AbortSignal
  readToken?: () => string | null | Promise<string | null>
}

/** Send once with the stored token, refreshing and retrying once when another process changed it. */
export async function sendWithStoredRecordSessionToken<T extends { status: number }>(
  send: (token: string | null) => Promise<T>,
  options: StoredRecordSessionSendOptions = {},
): Promise<T> {
  const readToken =
    options.readToken ??
    (() =>
      options.signal ? readRecordSessionTokenAsync(options.signal) : readRecordSessionToken())
  const token = await readToken()
  const response = await send(token)
  if (response.status !== 401) return response
  forgetRecordSessionToken()
  const refreshedToken = await readToken()
  return refreshedToken !== token ? send(refreshedToken) : response
}

/** Forget the process copy so a later read observes a session changed by another process. */
export function forgetRecordSessionToken(): void {
  tokenGeneration += 1
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
