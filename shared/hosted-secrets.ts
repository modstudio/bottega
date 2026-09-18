import {
  type ConfigClient,
  ConfigClientError,
  type ConfigSecret,
  configClient,
} from './config-client.ts'
import { machineKeyInfo, readMachineKey } from './machine-key-store.ts'
import { openValue, SecretEnvelopeError, unwrapDataKey } from './secret-envelope.ts'
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
    super(`hosted secret ${secretName} refused: ${reason}`, { cause })
    this.name = 'HostedSecretError'
    this.secretName = secretName
    this.reason = reason
  }
}

type Dependencies = {
  client: ConfigClient
  machine: Awaited<ReturnType<typeof machineKeyInfo>>
  trust: TrustList
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
    row = await deps.client.getSecret(name, 'user', 'default')
  } catch (error) {
    if (!(error instanceof ConfigClientError) || error.status !== 404) throw error
    try {
      requestedScope = 'space'
      row = await deps.client.getSecret(name, 'space', 'default')
    } catch (spaceError) {
      if (spaceError instanceof ConfigClientError && spaceError.status === 404) return undefined
      throw spaceError
    }
  }
  if (row.key !== name || row.environment !== 'default' || row.scope !== requestedScope)
    throw new HostedSecretError(name, 'authentication-failed')
  return { row, requestedScope }
}

async function one(name: string, deps: Dependencies): Promise<string | undefined> {
  const requested = await requestedRow(name, deps)
  if (!requested) return undefined
  const { row, requestedScope } = requested
  const key = await deps.client.getDataKey(row.dekId, deps.machine.keyId)
  const wrap = key.wraps.find((candidate) => deps.trust[candidate.senderKeyId]) ?? key.wraps[0]
  if (!wrap) throw new HostedSecretError(name, 'missing-wrap')
  const sender = deps.trust[wrap.senderKeyId]
  if (!sender) throw new HostedSecretError(name, 'untrusted-sender')
  try {
    const identity = await deps.client.whoami()
    if (!identity.activeSpaceId) throw new Error('record session has no active space')
    const dek = await unwrapDataKey({
      enc: new Uint8Array(Buffer.from(wrap.enc, 'base64url')),
      ciphertext: new Uint8Array(Buffer.from(wrap.ciphertext, 'base64url')),
      wrapContext: { spaceId: identity.activeSpaceId, dekId: key.id, dekVersion: key.version },
      recipientPrivateKey: deps.machine.privateKey,
      senderPublicKey: new Uint8Array(Buffer.from(sender.public_key, 'base64url')),
      trustedSenderKeyIds: new Set(Object.keys(deps.trust)),
    })
    const plaintext = openValue({
      envelope: new Uint8Array(Buffer.from(row.envelope, 'base64url')),
      dek,
      valueContext: {
        spaceId: identity.activeSpaceId,
        userId: requestedScope === 'user' ? identity.user.id : null,
        keyName: name,
        environment: 'default',
        dekId: row.dekId,
        rowVersion: row.rowVersion,
      },
    })
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
  } catch (error) {
    if (error instanceof HostedSecretError) throw error
    if (error instanceof SecretEnvelopeError) {
      const reason =
        error.reason === 'untrusted-sender' ? 'untrusted-sender' : 'authentication-failed'
      throw new HostedSecretError(name, reason, error)
    }
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
