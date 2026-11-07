import { readFileSync } from 'node:fs'

/** The repository's single Bun declaration, relative to the repository root. */
export const BUN_VERSION_FILE = '.bun-version'

const plainBunVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** The version a declaration file holds, or undefined unless it is exactly one plain version. */
export function declaredBunVersion(source: string | undefined): string | undefined {
  const version = source?.trim()
  if (version && plainBunVersion.test(version) && source?.replace(/\r?\n$/, '') === version) {
    return version
  }
  return undefined
}

function readReleaseBunVersion(): string {
  const version = declaredBunVersion(
    readFileSync(new URL(`../${BUN_VERSION_FILE}`, import.meta.url), 'utf8'),
  )
  if (!version)
    throw new Error(`${BUN_VERSION_FILE} must contain one plain version, for example 1.4.4`)
  return version
}

export const RELEASE_BUN_VERSION = readReleaseBunVersion()

export function requireReleaseBun(version = Bun.version): void {
  if (version !== RELEASE_BUN_VERSION) {
    throw new Error(
      `release builds require Bun ${RELEASE_BUN_VERSION}, received ${version}; run with Bun ${RELEASE_BUN_VERSION}`,
    )
  }
}
