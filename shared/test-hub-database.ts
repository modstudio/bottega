import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resolveStatePaths, type StateEnvironment } from './state-directory.ts'

type MintedHubDatabase = {
  database: string
  directory: string
  livePaths: string[]
}

let mintedHubDatabase: MintedHubDatabase | null = null

function canonicalPath(path: string): string {
  let existing = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      return resolve(realpathSync(existing), ...missing.reverse())
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return resolve(path)
      missing.push(basename(existing))
      existing = parent
    }
  }
}

function liveHubDatabasePaths(environment: StateEnvironment): string[] {
  const defaultEnvironment: StateEnvironment = { HOME: userInfo().homedir }
  return [environment, defaultEnvironment].map((candidate) =>
    canonicalPath(resolveStatePaths(candidate).hubDatabase),
  )
}

/** Decide whether the current store has the provenance recorded by the preload. */
export function testHubDatabasePathRefusal(
  mintedPath: string | null,
  currentPath: string | null,
  livePaths: readonly string[],
): string | null {
  if (mintedPath !== null && currentPath === mintedPath && !livePaths.includes(currentPath)) {
    return null
  }
  return (
    `test process refuses hub database: HUB_DB resolved ${currentPath ?? '<unset>'}; preload minted ${mintedPath ?? '<none minted>'}\n` +
    'invariant: A test suite never falls back to the live hub database.\n' +
    'cleared by: run the hub tests from hub/ so the package preload mints the store'
  )
}

/** Decide whether a caller-created store is safe to adopt as test-owned state. */
export function testHubDatabaseAdoptionRefusal(
  adoptedPath: string | null,
  adoptedExists: boolean,
  temporaryDirectory: string,
  livePaths: readonly string[],
): string | null {
  const offset = adoptedPath === null ? null : relative(temporaryDirectory, adoptedPath)
  if (
    adoptedPath !== null &&
    adoptedExists &&
    offset &&
    offset !== '..' &&
    !offset.startsWith(`..${sep}`) &&
    !isAbsolute(offset) &&
    !livePaths.includes(adoptedPath)
  ) {
    return null
  }
  return (
    `test process refuses hub database adoption: HUB_DB resolved ${adoptedPath ?? '<unset>'}${adoptedPath !== null && !adoptedExists ? ' (missing)' : ''}; temporary directory is ${temporaryDirectory}\n` +
    'invariant: A test suite never falls back to the live hub database.\n' +
    'cleared by: adopt only a caller-created hub store under the operating system temporary directory'
  )
}

/** Mint and record the only hub store this process may use for test fixtures. */
export function mintTestHubDatabase(databaseFileName: string): MintedHubDatabase {
  const environmentAtMint = { ...process.env }
  const livePaths = liveHubDatabasePaths(environmentAtMint)
  const temporaryDirectory = canonicalPath(tmpdir())
  const directory = mkdtempSync(join(temporaryDirectory, 'hub-test-'))
  const database = join(directory, databaseFileName)
  mintedHubDatabase = { database: canonicalPath(database), directory, livePaths }
  process.env.HUB_DB = database
  return mintedHubDatabase
}

/**
 * Adopt one caller-created temporary, non-live store as this test process's own.
 * @public Dynamically imported by the migration integration test's child process.
 */
export function adoptTestHubDatabase(configuredPath: string | undefined): void {
  const environmentAtAdoption = { ...process.env }
  const livePaths = liveHubDatabasePaths(environmentAtAdoption)
  const temporaryDirectory = canonicalPath(tmpdir())
  const database = configuredPath ? canonicalPath(configuredPath) : null
  const refusal = testHubDatabaseAdoptionRefusal(
    database,
    database !== null && existsSync(database),
    temporaryDirectory,
    livePaths,
  )
  if (refusal) throw new Error(refusal)
  mintedHubDatabase = {
    database: database!,
    directory: dirname(database!),
    livePaths,
  }
}

/** Refuse a test store unless this process's preload minted that exact non-live path. */
export function assertTestHubDatabasePath(): void {
  if (process.env.NODE_ENV !== 'test') return
  const currentPath = process.env.HUB_DB ? canonicalPath(process.env.HUB_DB) : null
  const refusal = testHubDatabasePathRefusal(
    mintedHubDatabase?.database ?? null,
    currentPath,
    mintedHubDatabase?.livePaths ?? [],
  )
  if (refusal) throw new Error(refusal)
}

/** Guard fixture resets with the same minted-store assertion used by hub startup. */
export function createTestHubDatabaseGuard(): () => void {
  return assertTestHubDatabasePath
}
