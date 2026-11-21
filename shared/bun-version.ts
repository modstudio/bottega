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

/** Read and validate one Bun version declaration. Filesystem failures remain distinguishable. */
export function readDeclaredBunVersion(file: string | URL): string | undefined {
  return declaredBunVersion(readFileSync(file, 'utf8'))
}
