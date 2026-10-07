// concern: config-secret-run
/** Resolves named secrets into a child environment and runs the requested command. */
import { ConfigClientError } from '../../../shared/config-client.ts'
import { readEnvValuesWithHosted } from '../../../shared/env-source.ts'
import { HostedSecretError } from '../../../shared/hosted-secrets.ts'

export const SECRET_RUN_WORKING_FORM =
  'orch config secret run --name <KEY> [--name <KEY> ...] -- <argv...>'

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

function namedSecretUnresolvedRefusal(unresolved: readonly string[]): string {
  const keys = unresolved.join(', ')
  const sets = unresolved.map((key) => `orch config secret set ${key}`).join(', ')
  return (
    `named secret${unresolved.length === 1 ? '' : 's'} ${keys} not set\n` +
    `cleared by: ${sets}, or add it to an env file the resolver reads`
  )
}

function hostedStoreUnread(error: unknown): boolean {
  if (error instanceof ConfigClientError) return error.reason !== 'not-configured'
  return error instanceof HostedSecretError
}

export async function runNamedSecrets(input: SecretRunInvocation): Promise<number> {
  let resolved: Record<string, string | undefined>
  try {
    resolved = await readEnvValuesWithHosted(input.names)
  } catch (error) {
    if (hostedStoreUnread(error)) throw new Error('hosted secret store could not be read')
    throw error
  }
  const child = childEnvironmentForNamedSecrets(input.names, resolved, process.env)
  if (!child.ok) throw new Error(namedSecretUnresolvedRefusal(child.unresolved))
  const spawned = Bun.spawn(input.argv, {
    env: child.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return (await spawned.exited) ?? 1
}
