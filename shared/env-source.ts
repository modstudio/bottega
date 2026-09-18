import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { type ConfigEnvironment, resolveEnvFilePaths } from './config-directory.ts'

export function resolveEnvValues(
  names: readonly string[],
  env: ConfigEnvironment,
  texts: readonly (string | undefined)[],
): Record<string, string | undefined> {
  const values = buildEnvironment(env, texts)
  return Object.fromEntries(names.map((name) => [name, values[name]]))
}

export function buildEnvironment(
  env: ConfigEnvironment,
  texts: readonly (string | undefined)[],
): ConfigEnvironment {
  const files: Record<string, string> = {}
  for (const text of texts) if (text !== undefined) Object.assign(files, parseEnv(text))
  const processValues = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return { ...files, ...processValues }
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
  const values = Object.fromEntries(names.map((name) => [name, env[name]]))
  if (names.every((name) => values[name] !== undefined)) return values
  const texts = resolveEnvFilePaths(env).map(readEnvFile)
  return resolveEnvValues(names, env, texts)
}

function readEnvironment(env: ConfigEnvironment): ConfigEnvironment {
  return buildEnvironment(env, resolveEnvFilePaths(env).map(readEnvFile))
}

if (import.meta.main) {
  const [command, separator, ...argv] = process.argv.slice(2)
  if (command !== 'run' || separator !== '--' || argv.length === 0) {
    throw new Error('working form: bun shared/env-source.ts run -- <argv...>')
  }
  const child = Bun.spawn(argv, {
    env: readEnvironment(process.env),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exit(await child.exited)
}
