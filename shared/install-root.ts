import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'

export type InstallEnvironment = Record<string, string | undefined>

/** The platform-specific installation-root override is derived from the one canonical slug. */
export const INSTALL_HOME_ENV = `${PLATFORM_SLUG.toUpperCase()}_HOME`

const DIST_MANIFEST = `.${PLATFORM_SLUG}-dist.json`

function isDistributionRoot(directory: string): boolean {
  return existsSync(join(directory, DIST_MANIFEST))
}

function isCheckoutRoot(directory: string): boolean {
  const manifest = join(directory, 'package.json')
  if (!existsSync(manifest)) return false
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
    return parsed.name === PLATFORM_SLUG
  } catch {
    return false
  }
}

/** Resolve the running distribution or checkout using only the supplied start and environment. */
export function resolveInstallRoot(fromDirectory: string, env: InstallEnvironment): string {
  const override = env[INSTALL_HOME_ENV]
  if (override && isAbsolute(override)) return override
  let directory = fromDirectory
  for (;;) {
    if (isDistributionRoot(directory) || isCheckoutRoot(directory)) return directory
    const parent = dirname(directory)
    if (parent === directory) {
      throw new Error(
        `cannot resolve the ${PLATFORM_SLUG} installation root: neither ${DIST_MANIFEST} nor a package.json named ${PLATFORM_SLUG} was found walking from ${fromDirectory}; set ${INSTALL_HOME_ENV} to the absolute installation root`,
      )
    }
    directory = parent
  }
}

/** The root of the running distribution or checkout. */
export function installRoot(): string {
  return resolveInstallRoot(import.meta.dir, process.env)
}

/** Join segments against the running distribution or checkout root. */
export function assetPath(...segments: string[]): string {
  return join(installRoot(), ...segments)
}
