import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

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

/** Decide the one hub database rule for test processes from canonical paths. */
export function testHubDatabasePathRefusal(
  isTestProcess: boolean,
  configuredPath: string | undefined,
  resolvedPath: string | null,
  temporaryDirectory: string,
): string | null {
  if (!isTestProcess) return null
  const offset = resolvedPath === null ? null : relative(temporaryDirectory, resolvedPath)
  if (
    configuredPath &&
    offset &&
    offset !== '..' &&
    !offset.startsWith(`..${sep}`) &&
    !isAbsolute(offset)
  ) {
    return null
  }
  const resolved = resolvedPath ?? (configuredPath === '' ? '<empty>' : '<unset>')
  return (
    `test process refuses hub database: HUB_DB resolved ${resolved}; temporary directory is ${temporaryDirectory}\n` +
    'invariant: A test suite never falls back to the live hub database.\n' +
    'cleared by: set HUB_DB to a scratch store under the operating system temporary directory before importing hub/src/db.ts'
  )
}

/** Refuse any test process state in which hub would open a store outside temporary storage. */
export function assertTestHubDatabasePath(
  isTestProcess: boolean,
  configuredPath: string | undefined,
): void {
  if (!isTestProcess) return
  const temporaryDirectory = canonicalPath(tmpdir())
  const resolvedPath = configuredPath ? canonicalPath(configuredPath) : null
  const refusal = testHubDatabasePathRefusal(
    isTestProcess,
    configuredPath,
    resolvedPath,
    temporaryDirectory,
  )
  if (refusal) throw new Error(refusal)
}

/** Refuse fixture resets unless the process uses its preload-minted temporary store. */
export function createTestHubDatabaseGuard(): () => void {
  return () => assertTestHubDatabasePath(true, process.env.HUB_DB)
}
