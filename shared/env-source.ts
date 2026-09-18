import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import {
  type ConfigEnvironment,
  resolveHarnessEnvFile,
  resolvePlatformEnvFile,
} from './config-directory.ts'

export type EnvironmentFileTexts = {
  platform?: string
  harness?: string
}

/**
 * Resolve env values with one precedence: process environment, then the platform
 * env file, then the harness env file.
 */
export function resolveEnvValues(
  names: readonly string[],
  env: ConfigEnvironment,
  texts: EnvironmentFileTexts,
): Record<string, string | undefined> {
  const platform = texts.platform === undefined ? {} : parseEnv(texts.platform)
  const harness = texts.harness === undefined ? {} : parseEnv(texts.harness)
  return Object.fromEntries(
    names.map((name) => [name, env[name] ?? platform[name] ?? harness[name]]),
  )
}

function readEnvFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot read environment file ${path}: ${detail}`)
  }
}

/** Read configured env files at use time and resolve the requested values. */
export function readEnvValues(
  names: readonly string[],
  env: ConfigEnvironment = process.env,
): Record<string, string | undefined> {
  const platformPath = resolvePlatformEnvFile(env)
  const harnessPath = resolveHarnessEnvFile(env)
  return resolveEnvValues(names, env, {
    platform: readEnvFile(platformPath),
    harness: harnessPath ? readEnvFile(harnessPath) : undefined,
  })
}
