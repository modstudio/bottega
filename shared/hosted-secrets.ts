import {
  type ConfigClient,
  ConfigClientError,
  type ConfigSecret,
  configClient,
} from './config-client.ts'
import type { HostedConfigIdentity } from './hosted-config-space.ts'
import {
  HOSTED_CONFIG_ENVIRONMENT,
  HostedOpenError,
  openHostedSecret,
} from './hosted-secret-opening.ts'
import { machineKeyInfo, readMachineKey } from './machine-key-store.ts'
import { readTrustList, type TrustList } from './trust-list.ts'

export type HostedSecretErrorReason =
  | 'machine-key-missing'
  | 'missing-wrap'
  | 'untrusted-sender'
  | 'authentication-failed'
  | 'hosted-failure'

export class HostedSecretError extends Error {
  readonly secretName: string
  readonly reason: HostedSecretErrorReason
  constructor(secretName: string, reason: HostedSecretErrorReason, cause?: unknown) {
    super(
      `hosted secret ${secretName} refused: ${reason}${cause instanceof Error ? `; ${cause.message}` : ''}`,
      { cause },
    )
    this.name = 'HostedSecretError'
    this.secretName = secretName
    this.reason = reason
  }
}

type Dependencies = {
  client: ConfigClient
  machine: Awaited<ReturnType<typeof machineKeyInfo>>
  trust: TrustList
  pinnedIdentity?: HostedConfigIdentity
}

async function defaults(): Promise<Dependencies> {
  const client = configClient()
  const pair = readMachineKey()
  if (!pair) throw new HostedSecretError('*', 'machine-key-missing')
  return { client, machine: await machineKeyInfo(pair), trust: await readTrustList() }
}

async function requestedRow(name: string, deps: Dependencies) {
  let row: ConfigSecret & { envelope: string }
  let requestedScope: ConfigSecret['scope'] = 'user'
  try {
    row = await deps.client.getSecret(name, 'user', HOSTED_CONFIG_ENVIRONMENT)
  } catch (error) {
    if (!(error instanceof ConfigClientError) || error.status !== 404) throw error
    try {
      requestedScope = 'space'
      row = await deps.client.getSecret(name, 'space', HOSTED_CONFIG_ENVIRONMENT)
    } catch (spaceError) {
      if (spaceError instanceof ConfigClientError && spaceError.status === 404) return undefined
      throw spaceError
    }
  }
  return { row, requestedScope }
}

async function one(name: string, deps: Dependencies): Promise<string | undefined> {
  const requested = await requestedRow(name, deps)
  if (!requested) return undefined
  const { row, requestedScope } = requested
  const key = await deps.client.getDataKey(row.dekId, deps.machine.keyId)
  try {
    const plaintext = await openHostedSecret({
      client: deps.client,
      row,
      key,
      machine: deps.machine,
      trust: deps.trust,
      expected: { key: name, scope: requestedScope, environment: HOSTED_CONFIG_ENVIRONMENT },
      pinnedIdentity: deps.pinnedIdentity,
    })
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
  } catch (error) {
    if (error instanceof HostedSecretError) throw error
    if (error instanceof HostedOpenError) throw new HostedSecretError(name, error.reason, error)
    throw new HostedSecretError(name, 'hosted-failure', error)
  }
}

/** Resolve user scope before space scope in environment `default`; plaintext stays in memory. */
export async function readHostedSecrets(
  names: readonly string[],
  injected?: Dependencies,
): Promise<Record<string, string | undefined>> {
  let deps: Dependencies
  try {
    deps = injected ?? (await defaults())
  } catch (error) {
    if (error instanceof ConfigClientError) throw error
    throw new HostedSecretError(
      names[0] ?? '*',
      error instanceof HostedSecretError ? error.reason : 'hosted-failure',
      error,
    )
  }
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        return [name, await one(name, deps)] as const
      } catch (error) {
        if (error instanceof HostedSecretError) throw error
        throw new HostedSecretError(name, 'hosted-failure', error)
      }
    }),
  )
  return Object.fromEntries(entries)
}
