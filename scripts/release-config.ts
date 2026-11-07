import { readFileSync } from 'node:fs'

export const RELEASE_BUN_VERSION = readFileSync(
  new URL('../.bun-version', import.meta.url),
  'utf8',
).trim()

export function requireReleaseBun(version = Bun.version): void {
  if (version !== RELEASE_BUN_VERSION) {
    throw new Error(
      `release builds require Bun ${RELEASE_BUN_VERSION}, received ${version}; run with Bun ${RELEASE_BUN_VERSION}`,
    )
  }
}
