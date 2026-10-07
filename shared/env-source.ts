import { ConfigClientError } from './config-client.ts'
import type { ConfigEnvironment } from './config-directory.ts'
import { readEnvValues as readConfiguredEnvValues, readEnvironment } from './env-values.ts'
import { readHostedSecrets } from './hosted-secrets.ts'

/** Read configured env files at use time and resolve the requested values. */
export function readEnvValues(
  names: readonly string[],
  env: ConfigEnvironment = process.env,
): Record<string, string | undefined> {
  return readConfiguredEnvValues(names, env)
}

/** Precedence: process environment, bottega.env, harness env file, then hosted secrets. */
export async function readEnvValuesWithHosted(
  names: readonly string[],
  env: ConfigEnvironment = process.env,
  hosted: typeof readHostedSecrets = readHostedSecrets,
): Promise<Record<string, string | undefined>> {
  const local = readEnvValues(names, env)
  const unresolved = names.filter((name) => local[name] === undefined)
  if (unresolved.length === 0) return local
  try {
    return { ...local, ...(await hosted(unresolved)) }
  } catch (error) {
    if (error instanceof ConfigClientError && error.reason === 'not-configured') return local
    throw error
  }
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
