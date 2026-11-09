// concern: config-data-key-access
/** Shared machine-key ceremonies and data-key wrapping primitives. */
import {
  type ConfigClient,
  ConfigClientError,
  type ConfigDestination,
  type DataKey,
} from '../../../shared/config-client.ts'
import { openClaimChallenge, unwrapDataKey, wrapDataKey } from '../../../shared/secret-envelope.ts'
import type { TrustList } from '../../../shared/trust-list.ts'

export const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'))
export const encoded = (value: Uint8Array) => Buffer.from(value).toString('base64url')
export const isNotFound = (error: unknown) =>
  error instanceof ConfigClientError && error.status === 404

export class DataKeyWrapAccessError extends Error {}

type MachineKeyPair = { publicKey: Uint8Array; privateKey: Uint8Array }
type LocalMachine = MachineKeyPair & { keyId: string }

export async function openDataKey(
  key: DataKey,
  spaceId: string,
  machine: MachineKeyPair,
  trust: TrustList,
) {
  const wrap = key.wraps.find((item) => trust[item.senderKeyId]) ?? key.wraps[0]
  if (!wrap)
    throw new DataKeyWrapAccessError(`data key ${key.id} has no wrap addressed to this machine`)
  const sender = trust[wrap.senderKeyId]
  if (!sender)
    throw new DataKeyWrapAccessError(`data key ${key.id} sender ${wrap.senderKeyId} is not trusted`)
  return unwrapDataKey({
    enc: bytes(wrap.enc),
    ciphertext: bytes(wrap.ciphertext),
    wrapContext: { spaceId, dekId: key.id, dekVersion: key.version },
    recipientPrivateKey: machine.privateKey,
    senderPublicKey: bytes(sender.public_key),
    trustedSenderKeyIds: new Set(Object.keys(trust)),
  })
}

export async function wrapsForRecipients(
  dek: Uint8Array,
  context: { spaceId: string; dekId: string; dekVersion: number },
  machine: LocalMachine,
  trust: TrustList,
  recipientKeyIds: readonly string[],
) {
  const sender = trust[machine.keyId]
  if (!sender) throw new Error('this machine is absent from the trust list')
  return Promise.all(
    recipientKeyIds.map(async (recipientKeyId) => {
      const recipient = trust[recipientKeyId]
      if (!recipient)
        throw new Error(`recipient machine ${recipientKeyId} is absent from the trust list`)
      const wrapped = await wrapDataKey({
        dek,
        wrapContext: context,
        senderPrivateKey: machine.privateKey,
        senderPublicKey: bytes(sender.public_key),
        recipientPublicKey: bytes(recipient.public_key),
      })
      return {
        recipientKeyId,
        senderKeyId: machine.keyId,
        enc: encoded(wrapped.enc),
        ciphertext: encoded(wrapped.ciphertext),
      }
    }),
  )
}

export async function claimMachineKey(
  pair: MachineKeyPair,
  keyId: string,
  spaceId: string,
  client: ConfigClient,
  destination?: ConfigDestination,
): Promise<void> {
  const challenge = await client.createMachineKeyClaimChallenge(keyId, destination)
  const nonce = await openClaimChallenge({
    enc: bytes(challenge.enc),
    ciphertext: bytes(challenge.ciphertext),
    spaceId,
    keyId,
    recipientPrivateKey: pair.privateKey,
    senderPublicKey: bytes(challenge.senderPublicKey),
  })
  await client.claimMachineKey(keyId, challenge.challengeId, encoded(nonce), destination)
}
