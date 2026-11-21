import { hostedApiFetch } from './bounded-fetch.ts'
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
  hostedIdentity,
  missingHostedDataKeyWrapError,
  openHostedSecret,
  pinnedHostedSecretDestination,
} from './hosted-secret-opening.ts'
import { machineKeyInfo, readMachineKey } from './machine-key-store.ts'
import { sealedValueIsEmpty } from './sealed-value.ts'
import { type TrustedKeys, trustedKeysForSpace } from './trust-log-keys.ts'

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

export type HostedSecretResolution = {
  values: Record<string, string | undefined>
  /** Names whose sealed copy was blank in every scope that held one. */
  sealedEmpty: readonly string[]
}

type Dependencies = {
  client: ConfigClient
  machine: Awaited<ReturnType<typeof machineKeyInfo>>
  trust: TrustedKeys
  pinnedIdentity?: HostedConfigIdentity
}

/** A blank copy is absent, so it is opened exactly like a row this scope does not hold. */
const SECRET_SCOPES = ['user', 'space'] as const

type OneSecret = { value?: string; sealedEmpty: boolean }

async function defaults(signal?: AbortSignal): Promise<Dependencies> {
  const client = configClient(process.env, hostedApiFetch, undefined, signal)
  const pair = readMachineKey()
  if (!pair) throw new HostedSecretError('*', 'machine-key-missing')
  const identity = await hostedIdentity(client)
  return {
    client,
    machine: await machineKeyInfo(pair),
    trust: await trustedKeysForSpace(client, identity.spaceId),
    pinnedIdentity: identity,
  }
}

async function rowInScope(
  name: string,
  scope: ConfigSecret['scope'],
  deps: Dependencies,
): Promise<(ConfigSecret & { envelope: string }) | undefined> {
  try {
    return await deps.client.getSecret(
      name,
      scope,
      HOSTED_CONFIG_ENVIRONMENT,
      await pinnedHostedSecretDestination(deps.client, deps.pinnedIdentity),
    )
  } catch (error) {
    if (error instanceof ConfigClientError && error.status === 404) return undefined
    throw error
  }
}

async function openedValue(
  name: string,
  row: ConfigSecret & { envelope: string },
  scope: ConfigSecret['scope'],
  key: Awaited<ReturnType<ConfigClient['getDataKey']>>,
  deps: Dependencies,
): Promise<string> {
  const identity = await hostedIdentity(deps.client, deps.pinnedIdentity)
  try {
    const plaintext = await openHostedSecret({
      row,
      key,
      machine: deps.machine,
      trust: deps.trust,
      expected: { key: name, scope, environment: HOSTED_CONFIG_ENVIRONMENT },
      identity,
    })
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
  } catch (error) {
    if (error instanceof HostedSecretError) throw error
    if (error instanceof HostedOpenError && error.reason === 'missing-wrap')
      throw new HostedSecretError(
        name,
        error.reason,
        await missingHostedDataKeyWrapError(deps.client, identity, deps.machine),
      )
    if (error instanceof HostedOpenError) throw new HostedSecretError(name, error.reason, error)
    throw new HostedSecretError(name, 'hosted-failure', error)
  }
}

async function one(name: string, deps: Dependencies): Promise<OneSecret> {
  let blank = false
  for (const scope of SECRET_SCOPES) {
    const row = await rowInScope(name, scope, deps)
    if (!row) continue
    const key = await deps.client.getDataKey(
      row.dekId,
      deps.machine.keyId,
      await pinnedHostedSecretDestination(deps.client, deps.pinnedIdentity),
    )
    const value = await openedValue(name, row, scope, key, deps)
    if (!sealedValueIsEmpty(value)) return { value, sealedEmpty: false }
    blank = true
  }
  return { sealedEmpty: blank }
}

/** Resolve user scope before space scope in environment `default`; plaintext stays in memory. */
export async function readHostedSecrets(
  names: readonly string[],
  injected?: Dependencies,
  signal?: AbortSignal,
): Promise<HostedSecretResolution> {
  let deps: Dependencies
  try {
    deps = injected ?? (await defaults(signal))
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
  return {
    values: Object.fromEntries(entries.map(([name, found]) => [name, found.value])),
    sealedEmpty: entries.filter(([, found]) => found.sealedEmpty).map(([name]) => name),
  }
}
