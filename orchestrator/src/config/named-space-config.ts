// concern: named-space-config-bootstrap
/** Registers and trusts machine keys in one hosted space without changing the active space. */
import { hostname } from 'node:os'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type ConfigClient,
  type ConfigDestination,
  configClient,
} from '../../../shared/config-client.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import { readHostedConfigIdentity } from '../../../shared/hosted-config-space.ts'
import { machineKeyId } from '../../../shared/machine-key-id.ts'
import { readMachineKey } from '../../../shared/machine-key-store.ts'
import {
  pinnedUserMismatchRemedy,
  RECORD_ACTIVE_SPACE_REMEDY,
  recordSpaceMembershipRefusal,
} from '../../../shared/record-remedies.ts'
import {
  parseRecordSpaceMemberships,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import { generateDataKey } from '../../../shared/secret-envelope.ts'
import { pinTrustedMachine, readTrustList } from '../../../shared/trust-list.ts'
import {
  bytes,
  claimMachineKey,
  DataKeyWrapAccessError,
  encoded,
  isNotFound,
  openDataKey,
  wrapsForRecipients,
} from './data-key-access.ts'
import { recordConfigCallOutcome } from './hosted-config-call-outcome.ts'
import { machineTrustRefusal } from './machine-trust-refusal.ts'

type NamedSpace = {
  destination: ConfigDestination
  slug: string
  spaceId: string
}

async function namedSpace(
  requested: string | undefined,
  client: ConfigClient,
  env: ConfigEnvironment,
): Promise<NamedSpace> {
  const current = await client.whoami()
  const pinned = readHostedConfigIdentity(env)
  if (pinned && current.user.id !== pinned.userId)
    throw new Error(pinnedUserMismatchRemedy(pinned.userId))
  const selected = requested ?? current.activeSpaceId
  if (!selected) throw new Error(RECORD_ACTIVE_SPACE_REMEDY)
  const membership = recordSpaceMembership(
    selected,
    parseRecordSpaceMemberships(current.memberships),
  )
  if (!membership) throw new Error(recordSpaceMembershipRefusal(selected))
  return {
    destination: { destinationSpaceId: membership.spaceId },
    slug: membership.slug,
    spaceId: membership.spaceId,
  }
}

async function wrapsForNamedSpace(
  dek: Uint8Array,
  dekId: string,
  space: NamedSpace,
  client: ConfigClient,
  pair: { publicKey: Uint8Array; privateKey: Uint8Array },
  keyId: string,
  env: ConfigEnvironment,
) {
  const [trusted, registered] = await Promise.all([
    readTrustList(env),
    client.listMachineKeys(space.destination),
  ])
  const recipientKeyIds = registered
    .filter((item) => item.userId !== null && item.revokedAt === null && trusted[item.keyId])
    .map((item) => item.keyId)
  return wrapsForRecipients(
    dek,
    { spaceId: space.spaceId, dekId, dekVersion: 1 },
    { ...pair, keyId },
    trusted,
    recipientKeyIds,
  )
}

function trustRemedy(space: NamedSpace, keyId: string, publicKey: string): Error {
  return new Error(
    `this machine has no data-key wrap in record space ${space.slug}; from a machine that already opens that space, run \`${PLATFORM_SLUG} machine config machine trust ${keyId} ${publicKey} --space ${space.slug}\``,
  )
}

export async function machineRegister(
  requestedSpace?: string,
  label = hostname(),
  client = configClient(process.env, fetch, undefined, undefined, recordConfigCallOutcome),
  env: ConfigEnvironment = process.env,
): Promise<string[]> {
  const pair = readMachineKey(env)
  if (!pair)
    throw new Error(
      `machine key is not initialized; run \`${PLATFORM_SLUG} machine config machine init\``,
    )
  const keyId = await machineKeyId(pair.publicKey)
  const publicKey = encoded(pair.publicKey)
  const space = await namedSpace(requestedSpace, client, env)
  const existing = (await client.listMachineKeys(space.destination)).find(
    (item) => item.keyId === keyId,
  )
  const registered = await client.registerMachineKey(keyId, publicKey, label, space.destination)
  const lines = [existing ? 'already registered' : 'registered']
  if (registered.userId === null) {
    await claimMachineKey(pair, keyId, space.spaceId, client, space.destination)
    lines.push('claimed')
  }
  try {
    const current = await client.currentDataKey(keyId, space.destination)
    if (current.wraps.length === 0) throw trustRemedy(space, keyId, publicKey)
    try {
      await openDataKey(current, space.spaceId, pair, await readTrustList(env))
    } catch (error) {
      if (!(error instanceof DataKeyWrapAccessError)) throw error
      const wrap = current.wraps[0]
      if (!wrap) throw trustRemedy(space, keyId, publicKey)
      throw new Error(
        `data key ${current.id} in record space ${space.slug} was wrapped by ${wrap.senderKeyId}, which this machine does not trust; pin it with \`${PLATFORM_SLUG} machine config machine trust ${wrap.senderKeyId} <publicKey> --space ${space.slug}\` using that machine's public key from \`${PLATFORM_SLUG} machine config machine show\``,
      )
    }
    lines.push('data key opened')
    return lines
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  const dek = generateDataKey()
  const dekId = crypto.randomUUID()
  await client.createDataKey(
    {
      dekId,
      version: 1,
      wraps: await wrapsForNamedSpace(dek, dekId, space, client, pair, keyId, env),
    },
    space.destination,
  )
  lines.push('data key created')
  return lines
}

export async function machineTrustInSpace(
  keyId: string,
  publicKey: string,
  label: string,
  requestedSpace: string,
  client = configClient(process.env, fetch, undefined, undefined, recordConfigCallOutcome),
  env: ConfigEnvironment = process.env,
): Promise<void> {
  const publicBytes = bytes(publicKey)
  if ((await machineKeyId(publicBytes)) !== keyId)
    throw new Error('machine key id does not match public key')
  const space = await namedSpace(requestedSpace, client, env)
  const remote = await client.listMachineKeys(space.destination)
  const registered = remote.find((item) => item.keyId === keyId)
  const refusal = machineTrustRefusal(keyId, registered, space.slug)
  if (refusal) throw new Error(refusal)
  await pinTrustedMachine(keyId, publicBytes, label, env)
  const pair = readMachineKey(env)
  if (!pair)
    throw new Error(
      `machine key is not initialized; run \`${PLATFORM_SLUG} machine config machine init\``,
    )
  const localKeyId = await machineKeyId(pair.publicKey)
  try {
    const current = await client.currentDataKey(localKeyId, space.destination)
    const trusted = await readTrustList(env)
    const dek = await openDataKey(current, space.spaceId, pair, trusted)
    const [wrapped] = await wrapsForRecipients(
      dek,
      { spaceId: space.spaceId, dekId: current.id, dekVersion: current.version },
      { ...pair, keyId: localKeyId },
      trusted,
      [keyId],
    )
    await client.addWraps(
      current.id,
      [
        {
          recipientKeyId: keyId,
          senderKeyId: localKeyId,
          enc: wrapped!.enc,
          ciphertext: wrapped!.ciphertext,
        },
      ],
      space.destination,
    )
  } catch (error) {
    if (!isNotFound(error)) throw error
    throw new Error(
      `record space ${space.slug} has no data key yet, so there is nothing to wrap; run \`${PLATFORM_SLUG} machine config machine register --space ${space.slug}\` on this machine to create it, then run this trust again`,
    )
  }
}
