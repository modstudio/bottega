import { PLATFORM_SLUG } from './brand.ts'
import type { ConfigClient, ConfigDestination, ConfigSecret, DataKey } from './config-client.ts'
import { type HostedConfigIdentity, readHostedConfigIdentity } from './hosted-config-space.ts'
import {
  machineNotTrustedRemedy,
  pinnedSpaceMismatchRemedy,
  pinnedUserMismatchRemedy,
  RECORD_ACTIVE_SPACE_REMEDY,
  recordSpaceMembershipRefusal,
} from './record-remedies.ts'
import { parseRecordSpaceMemberships } from './record-space-membership.ts'
import { recordSpaceRequestDecision } from './record-space-request.ts'
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
  | { allowed: false; reason: 'machine-not-trusted' }

/** Decide whether this user's machine registration may open values in one destination space. */
export function decideHostedSpaceOpen(input: {
  destinationSpaceId: string
  userId: string
  machine: { userId: string | null; revokedAt: string | null } | undefined
}): HostedSpaceOpenDecision {
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
): Promise<{ spaceId: string; userId: string }> {
  if (!pinned)
    throw new Error(
      `hosted config machine is not initialized; run \`${PLATFORM_SLUG} machine config machine init --space <slug>\``,
    )
  const current = await client.whoami()
  if (!current.activeSpaceId) throw new Error(RECORD_ACTIVE_SPACE_REMEDY)
  if (current.activeSpaceId !== pinned.spaceId)
    throw new Error(pinnedSpaceMismatchRemedy(pinned.spaceId))
  if (current.user.id !== pinned.userId) throw new Error(pinnedUserMismatchRemedy(pinned.userId))
  return pinned
}

/** Establish the signed-in user's identity for a project destination space. */
export async function destinationHostedIdentity(
  client: ConfigClient,
  destination: { spaceId: string; machineKeyId: string },
  pinned = readHostedConfigIdentity(),
): Promise<HostedConfigIdentity> {
  if (!pinned)
    throw new Error(
      `hosted config machine is not initialized; run \`${PLATFORM_SLUG} machine config machine init --space <slug>\``,
    )
  const current = await client.whoami()
  if (current.user.id !== pinned.userId) throw new Error(pinnedUserMismatchRemedy(pinned.userId))
  const membership = recordSpaceRequestDecision(
    destination.spaceId,
    current.activeSpaceId,
    parseRecordSpaceMemberships(current.memberships),
  )
  if (!membership.allowed) throw new Error(recordSpaceMembershipRefusal(membership.requestedSpace))
  const machines = await client.listMachineKeys({ destinationSpaceId: destination.spaceId })
  const decision = decideHostedSpaceOpen({
    destinationSpaceId: destination.spaceId,
    userId: current.user.id,
    machine: machines.find((machine) => machine.keyId === destination.machineKeyId),
  })
  if (decision.allowed) return decision.identity
  throw new Error(machineNotTrustedRemedy(destination.spaceId))
}

/** Choose whether a secret opens with the pinned active-space identity or a destination identity. */
export function hostedSecretIdentityKind(
  destinationSpaceId: string | undefined,
  pinnedSpaceId: string | undefined,
): 'active' | 'destination' {
  return !destinationSpaceId || destinationSpaceId === pinnedSpaceId ? 'active' : 'destination'
}

/** Resolve the hosted identity used to open one secret destination. */
export async function hostedSecretIdentity(
  client: ConfigClient,
  destination: ConfigDestination,
  machineKeyId: string,
  pinned = readHostedConfigIdentity(),
): Promise<HostedConfigIdentity> {
  if (hostedSecretIdentityKind(destination.destinationSpaceId, pinned?.spaceId) === 'active')
    return hostedIdentity(client, pinned)
  return destinationHostedIdentity(
    client,
    { spaceId: destination.destinationSpaceId!, machineKeyId },
    pinned,
  )
}

function trustedWrap(input: {
  key: DataKey
  trust: TrustList
  identity: HostedConfigIdentity
}): DataKey['wraps'][number] {
  const wrap = input.key.wraps.find((candidate) => input.trust[candidate.senderKeyId])
  if (wrap) return wrap
  if (input.key.wraps.length)
    throw new HostedOpenError('untrusted-sender', 'hosted secret data-key sender is not trusted')
  throw new HostedOpenError('missing-wrap', machineNotTrustedRemedy(input.identity.spaceId))
}

/** The only operation that chooses a wrap and opens a hosted secret row. */
export async function openHostedSecret(input: {
  row: ConfigSecret & { envelope: string }
  key: DataKey
  machine: MachineKeyPair & { keyId: string }
  trust: TrustList
  expected: { key: string; scope: ConfigSecret['scope']; environment: string }
  identity: HostedConfigIdentity
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
    const dek = await unwrapDataKey({
      enc: bytes(wrap.enc),
      ciphertext: bytes(wrap.ciphertext),
      wrapContext: {
        spaceId: input.identity.spaceId,
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
        spaceId: input.identity.spaceId,
        userId: expected.scope === 'user' ? input.identity.userId : null,
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
