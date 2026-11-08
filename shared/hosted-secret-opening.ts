import { PLATFORM_SLUG } from './brand.ts'
import type { ConfigClient, ConfigSecret, DataKey } from './config-client.ts'
import { type HostedConfigIdentity, readHostedConfigIdentity } from './hosted-config-space.ts'
import {
  pinnedSpaceMismatchRemedy,
  pinnedUserMismatchRemedy,
  RECORD_ACTIVE_SPACE_REMEDY,
} from './record-remedies.ts'
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

export type HostedSpaceOpenDecision =
  | { allowed: true; identity: { spaceId: string; userId: string } }
  | { allowed: false; reason: 'not-member' | 'no-config-access' | 'machine-not-trusted' }

/** Decide whether this user and machine may open values in one destination space. */
export function decideHostedSpaceOpen(input: {
  destinationSpaceId: string
  userId: string
  memberships: readonly { spaceId: string; slug: string; permission: string }[]
  configAccess: boolean
  machine: { userId: string | null; revokedAt: string | null } | undefined
}): HostedSpaceOpenDecision {
  if (!input.memberships.some((membership) => membership.spaceId === input.destinationSpaceId))
    return { allowed: false, reason: 'not-member' }
  if (!input.configAccess) return { allowed: false, reason: 'no-config-access' }
  if (!input.machine || input.machine.userId !== input.userId || input.machine.revokedAt !== null)
    return { allowed: false, reason: 'machine-not-trusted' }
  return {
    allowed: true,
    identity: { spaceId: input.destinationSpaceId, userId: input.userId },
  }
}

const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'))

export async function hostedIdentity(
  client: ConfigClient,
  pinned = readHostedConfigIdentity(),
  destination?: { spaceId: string; machineKeyId: string; configAccess: boolean },
): Promise<{ spaceId: string; userId: string }> {
  if (!pinned)
    throw new Error(
      `hosted config machine is not initialized; run \`${PLATFORM_SLUG} machine config machine init\``,
    )
  const current = await client.whoami()
  if (destination) {
    if (current.user.id !== pinned.userId) throw new Error(pinnedUserMismatchRemedy(pinned.userId))
    const machines = await client.listMachineKeys({ destinationSpaceId: destination.spaceId })
    const decision = decideHostedSpaceOpen({
      destinationSpaceId: destination.spaceId,
      userId: current.user.id,
      memberships: current.memberships.map((membership) => ({
        spaceId: membership.space_id,
        slug: membership.slug,
        permission: membership.permission,
      })),
      configAccess: destination.configAccess,
      machine: machines.find((machine) => machine.keyId === destination.machineKeyId),
    })
    if (decision.allowed) return decision.identity
    if (decision.reason === 'not-member')
      throw new Error(`signed-in user is not a member of record space ${destination.spaceId}`)
    if (decision.reason === 'no-config-access')
      throw new Error(
        `signed-in user lacks config access in record space ${destination.spaceId}; a space owner or admin grants it with \`${PLATFORM_SLUG} record space access grant <email>\``,
      )
    throw new Error(
      `this machine is not trusted in record space ${destination.spaceId}; from a machine trusted there, run \`${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey>\``,
    )
  }
  if (!current.activeSpaceId) throw new Error(RECORD_ACTIVE_SPACE_REMEDY)
  if (current.activeSpaceId !== pinned.spaceId)
    throw new Error(pinnedSpaceMismatchRemedy(pinned.spaceId))
  if (current.user.id !== pinned.userId) throw new Error(pinnedUserMismatchRemedy(pinned.userId))
  return pinned
}

function trustedWrap(input: {
  key: DataKey
  trust: TrustList
  destinationSpaceId?: string
}): DataKey['wraps'][number] {
  const wrap = input.key.wraps.find((candidate) => input.trust[candidate.senderKeyId])
  if (wrap) return wrap
  if (input.destinationSpaceId)
    throw new HostedOpenError(
      'missing-wrap',
      `this machine is not trusted in record space ${input.destinationSpaceId}; from a machine trusted there, run \`${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey>\``,
    )
  if (input.key.wraps.length)
    throw new HostedOpenError('untrusted-sender', 'hosted secret data-key sender is not trusted')
  throw new HostedOpenError('missing-wrap', 'hosted secret data key has no wrap for this machine')
}

/** The only operation that chooses a wrap and opens a hosted secret row. */
export async function openHostedSecret(input: {
  client: ConfigClient
  row: ConfigSecret & { envelope: string }
  key: DataKey
  machine: MachineKeyPair & { keyId: string }
  trust: TrustList
  expected: { key: string; scope: ConfigSecret['scope']; environment: string }
  pinnedIdentity?: HostedConfigIdentity | null
  destinationSpaceId?: string
}): Promise<Uint8Array> {
  const { row, expected } = input
  if (
    row.key !== expected.key ||
    row.scope !== expected.scope ||
    row.environment !== expected.environment
  )
    throw new HostedOpenError('authentication-failed', 'hosted secret response identity mismatch')
  const wrap = trustedWrap(input)
  const sender = input.trust[wrap.senderKeyId]
  if (!sender)
    throw new HostedOpenError('untrusted-sender', 'hosted secret data-key sender is not trusted')
  try {
    const identity = await hostedIdentity(
      input.client,
      input.pinnedIdentity,
      input.destinationSpaceId
        ? {
            spaceId: input.destinationSpaceId,
            machineKeyId: input.machine.keyId,
            configAccess: true,
          }
        : undefined,
    )
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
