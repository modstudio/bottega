import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'

export type ConfigEnvironment = Record<string, string | undefined>

/** The platform-specific config override is derived from the one canonical slug. */
export const CONFIG_HOME_ENV = `${PLATFORM_SLUG.toUpperCase()}_CONFIG_HOME`

/** The harness-owned env-file override is derived from the one canonical slug. */
export const HARNESS_ENV_FILE_ENV = `${PLATFORM_SLUG.toUpperCase()}_HARNESS_ENV_FILE`

/** Resolve the per-user config root using only the supplied environment. */
export function resolveConfigRoot(env: ConfigEnvironment): string {
  const override = env[CONFIG_HOME_ENV]
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error(
        `${CONFIG_HOME_ENV} must be an absolute config root; set it to an absolute path`,
      )
    }
    return override
  }
  const xdg = env.XDG_CONFIG_HOME
  if (xdg && isAbsolute(xdg)) return join(xdg, PLATFORM_SLUG)
  const home = env.HOME
  if (!home) {
    throw new Error(
      `cannot resolve ${PLATFORM_SLUG} config directory: set HOME, or set ${CONFIG_HOME_ENV} to an absolute config root`,
    )
  }
  return join(home, '.config', PLATFORM_SLUG)
}

export function resolvePlatformEnvFile(env: ConfigEnvironment): string {
  return join(resolveConfigRoot(env), `${PLATFORM_SLUG}.env`)
}

export function resolveHarnessEnvFile(env: ConfigEnvironment): string | null {
  const override = env[HARNESS_ENV_FILE_ENV]
  if (override === '') return null
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new Error(
        `${HARNESS_ENV_FILE_ENV} must be an absolute env-file path; set it to an absolute path or set it to the empty string to disable the harness source`,
      )
    }
    return override
  }
  const home = env.HOME
  if (!home) {
    throw new Error(
      `cannot resolve the harness env file: set HOME, set ${HARNESS_ENV_FILE_ENV} to an absolute path, or set ${HARNESS_ENV_FILE_ENV} to the empty string to disable the harness source`,
    )
  }
  return join(home, '.claude', '.env')
}

/** Env files in increasing specificity, suitable for repeated Bun --env-file options. */
export function resolveEnvFilePaths(env: ConfigEnvironment): string[] {
  const harness = resolveHarnessEnvFile(env)
  return [...(harness ? [harness] : []), resolvePlatformEnvFile(env)]
}

if (import.meta.main) {
  const command = process.argv[2]
  const env = process.env as ConfigEnvironment
  const paths = resolveEnvFilePaths(env)
  if (command === 'env-files') {
    for (const path of paths) if (existsSync(path)) console.log(path)
  } else if (command === 'env-paths') {
    for (const path of paths) console.log(path)
  } else {
    throw new Error('working form: bun shared/config-directory.ts env-files | env-paths')
  }
}
