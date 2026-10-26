// concern: config-secret-run
/** Resolves named secrets into a child environment and runs the requested command. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveEnvValuesWithHosted } from '../../../shared/env-source.ts'
import { secretResolutionFailure } from '../../../shared/secret-resolution-failure.ts'
import { assertRecordConnectionResolutionAllowed } from '../sandbox/record-connection-env.ts'
export const SECRET_RUN_WORKING_FORM = `${PLATFORM_SLUG} machine config secret run --name <KEY> [--name <KEY> ...] -- <argv...>`

type SecretRunInvocation = { names: string[]; argv: string[] }

type ChildEnvironment =
  | { ok: true; env: Record<string, string | undefined> }
  | { ok: false; unresolved: string[] }

function malformed(condition: string): never {
  throw new Error(`${condition}\nworking form: ${SECRET_RUN_WORKING_FORM}`)
}

function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>()
  return names.filter((name) => {
    if (seen.has(name)) return false
    seen.add(name)
    return true
  })
}

function namedFlag(
  tokens: readonly string[],
  index: number,
): { value: string; next: number } | null {
  const token = tokens[index]!
  if (token.startsWith('--name=')) {
    const value = token.slice('--name='.length)
    if (!value) malformed('missing --name')
    return { value, next: index + 1 }
  }
  if (token !== '--name') return null
  const value = tokens[index + 1]
  if (value === undefined || value === '--' || value.startsWith('--')) {
    malformed('argument --name needs a value')
  }
  return { value, next: index + 2 }
}

export function parseSecretRunArgs(tokens: readonly string[]): SecretRunInvocation {
  const names: string[] = []
  let separator = -1
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === '--') {
      separator = index
      break
    }
    const flag = namedFlag(tokens, index)
    if (!flag) malformed('missing --')
    names.push(flag.value)
    index = flag.next - 1
  }
  if (names.length === 0) malformed('missing --name')
  if (separator < 0) malformed('missing --')
  const argv = tokens.slice(separator + 1).map(String)
  if (argv.length === 0) malformed('empty argv')
  return { names: uniqueNames(names), argv }
}

export function childEnvironmentForNamedSecrets(
  names: readonly string[],
  resolved: Readonly<Record<string, string | undefined>>,
  base: Readonly<Record<string, string | undefined>>,
): ChildEnvironment {
  const requested = uniqueNames(names)
  const unresolved = requested.filter((name) => resolved[name] === undefined)
  if (unresolved.length > 0) return { ok: false, unresolved }
  const env: Record<string, string | undefined> = { ...base }
  for (const name of requested) env[name] = resolved[name]
  return { ok: true, env }
}

/** A resolved name is added to the child; a name the resolver could not produce is refused. */
export function namedSecretUnresolvedRefusal(
  unresolved: readonly string[],
  sealedEmpty: readonly string[],
): string {
  const sealed = new Set(sealedEmpty)
  const empty = unresolved.filter((key) => sealed.has(key))
  const unset = unresolved.filter((key) => !sealed.has(key))
  const states = [
    ...(empty.length ? [`${empty.join(', ')} is sealed empty`] : []),
    ...(unset.length ? [`${unset.join(', ')} not set`] : []),
  ]
  const sets = unresolved
    .map((key) => `${PLATFORM_SLUG} machine config secret set ${key}`)
    .join(', ')
  return (
    `named secret${unresolved.length === 1 ? '' : 's'} ${states.join(', ')}\n` +
    `cleared by: ${sets}, or add it to an env file the resolver reads`
  )
}

export async function runNamedSecrets(input: SecretRunInvocation): Promise<number> {
  assertRecordConnectionResolutionAllowed(input.names, process.env)
  let resolution: Awaited<ReturnType<typeof resolveEnvValuesWithHosted>>
  try {
    resolution = await resolveEnvValuesWithHosted(input.names)
  } catch (error) {
    const failure = secretResolutionFailure(error)
    if (failure) throw new Error(failure)
    throw error
  }
  const child = childEnvironmentForNamedSecrets(input.names, resolution.values, process.env)
  if (!child.ok)
    throw new Error(namedSecretUnresolvedRefusal(child.unresolved, resolution.sealedEmpty))
  const spawned = Bun.spawn(input.argv, {
    env: child.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return (await spawned.exited) ?? 1
}
