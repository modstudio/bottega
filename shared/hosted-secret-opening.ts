import type { ConfigClient, ConfigSecret, DataKey } from './config-client.ts'
import { readHostedConfigSpace } from './hosted-config-space.ts'
import { pinnedSpaceMismatchRemedy, RECORD_ACTIVE_SPACE_REMEDY } from './record-remedies.ts'
import type { MachineKeyPair } from './secret-envelope.ts'
import { openValue, SecretEnvelopeError, unwrapDataKey } from './secret-envelope.ts'
import type { TrustList } from './trust-list.ts'

export const HOSTED_CONFIG_ENVIRONMENT = 'default'

export type HostedOpenReason = 'missing-wrap' | 'untrusted-sender' | 'authentication-failed'

export class HostedOpenError extends Error {
  readonly reason: HostedOpenReason

  constructor(reason: HostedOpenReason, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HostedOpenError'
    this.reason = reason
  }
}

const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'))

export async function hostedIdentity(
  client: ConfigClient,
  pinnedSpace = readHostedConfigSpace(),
): Promise<{ spaceId: string; userId: string }> {
  if (!pinnedSpace)
    throw new Error('hosted config machine is not initialized; run `orch config machine init`')
  const current = await client.whoami()
  if (!current.activeSpaceId) throw new Error(RECORD_ACTIVE_SPACE_REMEDY)
  if (current.activeSpaceId !== pinnedSpace) throw new Error(pinnedSpaceMismatchRemedy(pinnedSpace))
  return { spaceId: pinnedSpace, userId: current.user.id }
}

/** The only operation that chooses a wrap and opens a hosted secret row. */
export async function openHostedSecret(input: {
  client: ConfigClient
  row: ConfigSecret & { envelope: string }
  key: DataKey
  machine: MachineKeyPair & { keyId: string }
  trust: TrustList
  expected: { key: string; scope: ConfigSecret['scope']; environment: string }
  pinnedSpace?: string | null
}): Promise<Uint8Array> {
  const { row, expected } = input
  if (
    row.key !== expected.key ||
    row.scope !== expected.scope ||
    row.environment !== expected.environment
  )
    throw new HostedOpenError('authentication-failed', 'hosted secret response identity mismatch')
  const wrap = input.key.wraps.find((candidate) => input.trust[candidate.senderKeyId])
  if (!wrap) {
    if (input.key.wraps.length)
      throw new HostedOpenError('untrusted-sender', 'hosted secret data-key sender is not trusted')
    throw new HostedOpenError('missing-wrap', 'hosted secret data key has no wrap for this machine')
  }
  const sender = input.trust[wrap.senderKeyId]
  if (!sender)
    throw new HostedOpenError('untrusted-sender', 'hosted secret data-key sender is not trusted')
  try {
    const identity = await hostedIdentity(input.client, input.pinnedSpace)
    const dek = await unwrapDataKey({
      enc: bytes(wrap.enc),
      ciphertext: bytes(wrap.ciphertext),
      wrapContext: {
        spaceId: identity.spaceId,
        dekId: input.key.id,
        dekVersion: input.key.version,
      },
      recipientPrivateKey: input.machine.privateKey,
      senderPublicKey: bytes(sender.public_key),
      trustedSenderKeyIds: new Set(Object.keys(input.trust)),
    })
    return openValue({
      envelope: bytes(row.envelope),
      dek,
      valueContext: {
        spaceId: identity.spaceId,
        userId: expected.scope === 'user' ? identity.userId : null,
        keyName: row.key,
        environment: row.environment,
        dekId: row.dekId,
        rowVersion: row.rowVersion,
      },
    })
  } catch (error) {
    if (error instanceof HostedOpenError) throw error
    if (error instanceof SecretEnvelopeError)
      throw new HostedOpenError(
        error.reason === 'untrusted-sender' ? 'untrusted-sender' : 'authentication-failed',
        error.message,
        { cause: error },
      )
    throw error
  }
}
