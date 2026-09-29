export const RELEASE_BUN_VERSION = '1.4.2'

export function requireReleaseBun(version = Bun.version): void {
  if (version !== RELEASE_BUN_VERSION) {
    throw new Error(
      `release builds require Bun ${RELEASE_BUN_VERSION}, received ${version}; run with Bun ${RELEASE_BUN_VERSION}`,
    )
  }
}
