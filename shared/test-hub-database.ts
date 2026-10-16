import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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

/** Mint and record the only hub store this process may use for test fixtures. */
export function mintTestHubDatabase(databaseFileName: string): MintedHubDatabase {
  const environmentAtMint = { ...process.env }
  const defaultEnvironment: StateEnvironment = { HOME: userInfo().homedir }
  const livePaths = [environmentAtMint, defaultEnvironment].map((environment) =>
    canonicalPath(resolveStatePaths(environment).hubDatabase),
  )
  const temporaryDirectory = canonicalPath(tmpdir())
  const directory = mkdtempSync(join(temporaryDirectory, 'hub-test-'))
  const database = join(directory, databaseFileName)
  mintedHubDatabase = { database: canonicalPath(database), directory, livePaths }
  process.env.HUB_DB = database
  return mintedHubDatabase
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
