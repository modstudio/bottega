// concern: config-secret-run
/** Resolves named secrets into a child environment and runs the requested command. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveEnvValuesWithHosted } from '../../../shared/env-source.ts'
import { secretResolutionFailure } from '../../../shared/secret-resolution-failure.ts'
import { assertRecordConnectionResolutionAllowed } from '../sandbox/record-connection-env.ts'
export const SECRET_RUN_WORKING_FORM = `${PLATFORM_SLUG} machine config secret run --name <KEY> [--name <KEY> ...] -- <argv...>`

type SecretRunInvocation = { names: string[]; argv: string[] }
export type TypedCredentialPath = { path: string; mode: 'live' | 'test' | 'default' }
export type TypedCredentialPathLookup = () => Promise<readonly TypedCredentialPath[]>

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
  typedCredentialPaths?: readonly TypedCredentialPath[],
): string {
  const sealed = new Set(sealedEmpty)
  const empty = unresolved.filter((key) => sealed.has(key))
  const unset = unresolved.filter((key) => !sealed.has(key))
  const states = [
    ...(empty.length ? [`${empty.join(', ')} is sealed empty`] : []),
    ...(unset.length ? [`${unset.join(', ')} not set`] : []),
  ]
  const credentialMatches = new Map(
    unresolved.flatMap((key) => {
      const path = matchingTypedCredentialPath(key, typedCredentialPaths ?? [])
      return path ? [[key, path] as const] : []
    }),
  )
  const remedies = unresolved.map((key) => {
    const path = credentialMatches.get(key)
    return path
      ? `${PLATFORM_SLUG} credential resolve ${path.path}${path.mode === 'default' ? '' : ` --mode ${path.mode}`} --project <name> --reveal-to-env ${key} -- <argv>`
      : `${PLATFORM_SLUG} machine config secret set ${key}`
  })
  if (credentialMatches.size !== unresolved.length)
    remedies.push(`${PLATFORM_SLUG} credential list`)
  return (
    `named secret${unresolved.length === 1 ? '' : 's'} ${states.join(', ')}\n` +
    `cleared by: ${remedies.join(', ')}, or add it to an env file the resolver reads`
  )
}

/** Match the conventional environment name only when that typed credential is available. */
export function matchingTypedCredentialPath(
  secretName: string,
  availablePaths: readonly TypedCredentialPath[],
): TypedCredentialPath | null {
  const match = /^([A-Z0-9]+(?:_[A-Z0-9]+)*)_API_KEY$/.exec(secretName)
  if (!match) return null
  // credentialIdentityPath owns this slash-delimited format; this matcher accepts no named key.
  const path = `${match[1]!.toLowerCase().replaceAll('_', '-')}/api-key`
  const modes = [
    ...new Set(availablePaths.filter((row) => row.path === path).map((row) => row.mode)),
  ]
  if (modes.includes('default')) return { path, mode: 'default' }
  return modes.length === 1 ? { path, mode: modes[0]! } : null
}

export async function typedCredentialPathsOrUnchecked(
  lookup?: TypedCredentialPathLookup,
): Promise<readonly TypedCredentialPath[] | undefined> {
  if (!lookup) return undefined
  try {
    return await lookup()
  } catch {
    return undefined
  }
}

/** Run argv with an already-resolved child environment and inherited terminal streams. */
export async function runWithEnvironment(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const spawned = Bun.spawn([...argv], {
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return (await spawned.exited) ?? 1
}

export async function runNamedSecrets(
  input: SecretRunInvocation,
  typedCredentialPathLookup?: TypedCredentialPathLookup,
): Promise<number> {
  assertRecordConnectionResolutionAllowed(input.names, process.env)
  let resolution: Awaited<ReturnType<typeof resolveEnvValuesWithHosted>>
  try {
    resolution = await resolveEnvValuesWithHosted(input.names)
  } catch (error) {
    const failure = secretResolutionFailure(error)
    if (failure)
      throw new Error(`${failure}\ntyped provider credentials: ${PLATFORM_SLUG} credential list`)
    throw error
  }
  const child = childEnvironmentForNamedSecrets(input.names, resolution.values, process.env)
  if (!child.ok) {
    const typedCredentialPaths = await typedCredentialPathsOrUnchecked(typedCredentialPathLookup)
    throw new Error(
      namedSecretUnresolvedRefusal(child.unresolved, resolution.sealedEmpty, typedCredentialPaths),
    )
  }
  return runWithEnvironment(input.argv, child.env)
}
