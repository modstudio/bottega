import { BUN_VERSION_FILE, readDeclaredBunVersion } from '../shared/bun-version.ts'

function readReleaseBunVersion(): string {
  const version = readDeclaredBunVersion(new URL(`../${BUN_VERSION_FILE}`, import.meta.url))
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
