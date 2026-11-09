// concern: named-space-config-bootstrap
/** Registers and trusts machine keys in one hosted space without changing the active space. */
import { hostname } from 'node:os'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type ConfigClient,
  ConfigClientError,
  type ConfigDestination,
  configClient,
  type DataKey,
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
import {
  generateDataKey,
  openClaimChallenge,
  unwrapDataKey,
  wrapDataKey,
} from '../../../shared/secret-envelope.ts'
import { pinTrustedMachine, readTrustList } from '../../../shared/trust-list.ts'
import { recordConfigCallOutcome } from './hosted-config-call-outcome.ts'

const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'))
const encoded = (value: Uint8Array) => Buffer.from(value).toString('base64url')
const isNotFound = (error: unknown) => error instanceof ConfigClientError && error.status === 404

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

async function claimRegistration(
  pair: { publicKey: Uint8Array; privateKey: Uint8Array },
  keyId: string,
  space: NamedSpace,
  client: ConfigClient,
): Promise<void> {
  const challenge = await client.createMachineKeyClaimChallenge(keyId, space.destination)
  const nonce = await openClaimChallenge({
    enc: bytes(challenge.enc),
    ciphertext: bytes(challenge.ciphertext),
    spaceId: space.spaceId,
    keyId,
    recipientPrivateKey: pair.privateKey,
    senderPublicKey: bytes(challenge.senderPublicKey),
  })
  await client.claimMachineKey(keyId, challenge.challengeId, encoded(nonce), space.destination)
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
  const sender = trusted[keyId]
  if (!sender) throw new Error('this machine is absent from the trust list')
  const recipients = registered.filter(
    (item) => item.userId !== null && item.revokedAt === null && trusted[item.keyId],
  )
  return Promise.all(
    recipients.map(async (recipient) => {
      const wrapped = await wrapDataKey({
        dek,
        wrapContext: { spaceId: space.spaceId, dekId, dekVersion: 1 },
        senderPrivateKey: pair.privateKey,
        senderPublicKey: bytes(sender.public_key),
        recipientPublicKey: bytes(trusted[recipient.keyId]!.public_key),
      })
      return {
        recipientKeyId: recipient.keyId,
        senderKeyId: keyId,
        enc: encoded(wrapped.enc),
        ciphertext: encoded(wrapped.ciphertext),
      }
    }),
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
    await claimRegistration(pair, keyId, space, client)
    lines.push('claimed')
  }
  try {
    const current = await client.currentDataKey(keyId, space.destination)
    if (current.wraps.length === 0) throw trustRemedy(space, keyId, publicKey)
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

async function openNamedDataKey(
  current: DataKey,
  space: NamedSpace,
  pair: { publicKey: Uint8Array; privateKey: Uint8Array },
) {
  const trusted = await readTrustList()
  const wrap = current.wraps.find((item) => trusted[item.senderKeyId]) ?? current.wraps[0]
  if (!wrap) throw new Error(`data key ${current.id} has no wrap addressed to this machine`)
  const sender = trusted[wrap.senderKeyId]
  if (!sender) throw new Error(`data key ${current.id} sender ${wrap.senderKeyId} is not trusted`)
  return unwrapDataKey({
    enc: bytes(wrap.enc),
    ciphertext: bytes(wrap.ciphertext),
    wrapContext: { spaceId: space.spaceId, dekId: current.id, dekVersion: current.version },
    recipientPrivateKey: pair.privateKey,
    senderPublicKey: bytes(sender.public_key),
    trustedSenderKeyIds: new Set(Object.keys(trusted)),
  })
}

export async function machineTrustInSpace(
  keyId: string,
  publicKey: string,
  label: string,
  requestedSpace: string,
  client: ConfigClient,
): Promise<void> {
  const publicBytes = bytes(publicKey)
  if ((await machineKeyId(publicBytes)) !== keyId)
    throw new Error('machine key id does not match public key')
  const space = await namedSpace(requestedSpace, client, process.env)
  const remote = await client.listMachineKeys(space.destination)
  const registered = remote.find((item) => item.keyId === keyId)
  if (!registered || registered.revokedAt)
    throw new Error(`machine key ${keyId} is not registered and active in this space`)
  await pinTrustedMachine(keyId, publicBytes, label)
  const pair = readMachineKey()
  if (!pair)
    throw new Error(
      `machine key is not initialized; run \`${PLATFORM_SLUG} machine config machine init\``,
    )
  const localKeyId = await machineKeyId(pair.publicKey)
  try {
    const current = await client.currentDataKey(localKeyId, space.destination)
    const dek = await openNamedDataKey(current, space, pair)
    const trusted = await readTrustList()
    const sender = trusted[localKeyId]
    const recipient = trusted[keyId]
    if (!sender || !recipient)
      throw new Error('machine is absent from the trust list after pinning')
    const wrapped = await wrapDataKey({
      dek,
      wrapContext: { spaceId: space.spaceId, dekId: current.id, dekVersion: current.version },
      senderPrivateKey: pair.privateKey,
      senderPublicKey: bytes(sender.public_key),
      recipientPublicKey: bytes(recipient.public_key),
    })
    await client.addWraps(
      current.id,
      [
        {
          recipientKeyId: keyId,
          senderKeyId: localKeyId,
          enc: encoded(wrapped.enc),
          ciphertext: encoded(wrapped.ciphertext),
        },
      ],
      space.destination,
    )
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
}
