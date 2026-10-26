import { ConfigClientError } from './config-client.ts'
import type { ConfigEnvironment } from './config-directory.ts'
import { readEnvValues as readConfiguredEnvValues, readEnvironment } from './env-values.ts'
import { type HostedSecretResolution, readHostedSecrets } from './hosted-secrets.ts'

/** Read configured env files at use time and resolve the requested values. */
export function readEnvValues(
  names: readonly string[],
  env: ConfigEnvironment = process.env,
): Record<string, string | undefined> {
  return readConfiguredEnvValues(names, env)
}

/**
 * Precedence: process environment, bottega.env, harness env file, then hosted secrets.
 *
 * The hosted read reports the names whose sealed copy was blank, because a blank copy resolves
 * exactly as an absent one does and a refusal has to say which of the two it found.
 */
export async function resolveEnvValuesWithHosted(
  names: readonly string[],
  env: ConfigEnvironment = process.env,
  hosted: typeof readHostedSecrets = readHostedSecrets,
): Promise<HostedSecretResolution> {
  const local = readEnvValues(names, env)
  const unresolved = names.filter((name) => local[name] === undefined)
  if (unresolved.length === 0) return { values: local, sealedEmpty: [] }
  try {
    const sealed = await hosted(unresolved)
    return { values: { ...local, ...sealed.values }, sealedEmpty: sealed.sealedEmpty }
  } catch (error) {
    if (error instanceof ConfigClientError && error.reason === 'not-configured')
      return { values: local, sealedEmpty: [] }
    throw error
  }
}

/** The resolved values alone, for a caller with nothing to report about a sealed-empty copy. */
export async function readEnvValuesWithHosted(
  names: readonly string[],
  env: ConfigEnvironment = process.env,
  hosted: typeof readHostedSecrets = readHostedSecrets,
): Promise<Record<string, string | undefined>> {
  return (await resolveEnvValuesWithHosted(names, env, hosted)).values
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
