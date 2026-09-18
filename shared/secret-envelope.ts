import { Chacha20Poly1305 } from '@hpke/chacha20poly1305'
import { CipherSuite, HkdfSha256 } from '@hpke/core'
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { PLATFORM_SLUG } from './brand.ts'

const FORMAT_VERSION = 1
const ALGORITHM_ID = 1
const KEY_SIZE = 32
const NONCE_SIZE = 24
const TAG_SIZE = 16
const HEADER_SIZE = 2
const NULL_USER_SENTINEL = '\0'
const VALUE_LABEL = `${PLATFORM_SLUG}.secret-envelope.value`
const WRAP_LABEL = `${PLATFORM_SLUG}.secret-envelope.wrap`

const textEncoder = new TextEncoder()
const hpkeSuite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
})

export type SecretEnvelopeErrorReason =
  | 'unknown-version'
  | 'unknown-algorithm'
  | 'untrusted-sender'
  | 'authentication-failed'
  | 'malformed-envelope'

export class SecretEnvelopeError extends Error {
  readonly reason: SecretEnvelopeErrorReason

  constructor(reason: SecretEnvelopeErrorReason) {
    super(
      {
        'unknown-version': 'The secret envelope version is not supported.',
        'unknown-algorithm': 'The secret envelope algorithm is not supported.',
        'untrusted-sender': 'The data key sender is not trusted.',
        'authentication-failed': 'Secret authentication failed.',
        'malformed-envelope': 'The secret envelope is malformed.',
      }[reason],
    )
    this.name = 'SecretEnvelopeError'
    this.reason = reason
  }
}

export type MachineKeyPair = {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export type ValueContext = {
  spaceId: string
  userId: string | null
  keyName: string
  environment: string
  dekId: string
  rowVersion: number
}

export type WrapContext = {
  spaceId: string
  dekId: string
  dekVersion: number
}

function malformed(): never {
  throw new SecretEnvelopeError('malformed-envelope')
}

function requireLength(value: Uint8Array, length: number): void {
  if (value.length !== length) malformed()
}

function unsignedDecimal(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) malformed()
  return String(value)
}

function encodeFields(label: string, fields: string[]): Uint8Array {
  const encoded = [label, ...fields].map((field) => textEncoder.encode(field))
  let size = 0
  for (const field of encoded) {
    if (field.length > 0xffffffff) malformed()
    size += 4 + field.length
  }

  const result = new Uint8Array(size)
  const view = new DataView(result.buffer)
  let offset = 0
  for (const field of encoded) {
    view.setUint32(offset, field.length)
    offset += 4
    result.set(field, offset)
    offset += field.length
  }
  return result
}

function encodeValueContext(context: ValueContext): Uint8Array {
  return encodeFields(VALUE_LABEL, [
    unsignedDecimal(FORMAT_VERSION),
    unsignedDecimal(ALGORITHM_ID),
    context.spaceId.toLowerCase(),
    context.userId === null ? NULL_USER_SENTINEL : context.userId.toLowerCase(),
    context.keyName.normalize('NFC'),
    context.environment.normalize('NFC'),
    context.dekId.toLowerCase(),
    unsignedDecimal(context.rowVersion),
  ])
}

function encodeWrapContext(context: WrapContext): Uint8Array {
  return encodeFields(WRAP_LABEL, [
    context.spaceId.toLowerCase(),
    context.dekId.toLowerCase(),
    unsignedDecimal(context.dekVersion),
  ])
}

/**
 * Generates a raw X25519 key pair. The private key is bootstrap material and must remain local.
 */
export async function generateMachineKeyPair(): Promise<MachineKeyPair> {
  const pair = await hpkeSuite.kem.generateKeyPair()
  const [publicKey, privateKey] = await Promise.all([
    hpkeSuite.kem.serializePublicKey(pair.publicKey),
    hpkeSuite.kem.serializePrivateKey(pair.privateKey),
  ])
  return { publicKey: new Uint8Array(publicKey), privateKey: new Uint8Array(privateKey) }
}

/**
 * Returns the persisted machine key id: the first 128 bits of SHA-256 over the raw public key,
 * encoded as 22 characters of unpadded base64url. The same value is used for human comparison.
 */
export async function machineKeyId(publicKey: Uint8Array): Promise<string> {
  requireLength(publicKey, KEY_SIZE)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey))
  const binary = String.fromCharCode(...digest.subarray(0, 16))
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function generateDataKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_SIZE))
}

export async function wrapDataKey({
  dek,
  wrapContext,
  senderPrivateKey,
  senderPublicKey,
  recipientPublicKey,
}: {
  dek: Uint8Array
  wrapContext: WrapContext
  senderPrivateKey: Uint8Array
  senderPublicKey: Uint8Array
  recipientPublicKey: Uint8Array
}): Promise<{ enc: Uint8Array; ciphertext: Uint8Array }> {
  requireLength(dek, KEY_SIZE)
  requireLength(senderPrivateKey, KEY_SIZE)
  requireLength(senderPublicKey, KEY_SIZE)
  requireLength(recipientPublicKey, KEY_SIZE)
  const [privateKey, publicKey, recipientKey] = await Promise.all([
    hpkeSuite.kem.deserializePrivateKey(senderPrivateKey),
    hpkeSuite.kem.deserializePublicKey(senderPublicKey),
    hpkeSuite.kem.deserializePublicKey(recipientPublicKey),
  ])
  const sender = await hpkeSuite.createSenderContext({
    recipientPublicKey: recipientKey,
    senderKey: { privateKey, publicKey },
    info: encodeWrapContext(wrapContext),
  })
  const ciphertext = await sender.seal(dek)
  return { enc: new Uint8Array(sender.enc), ciphertext: new Uint8Array(ciphertext) }
}

export async function unwrapDataKey({
  enc,
  ciphertext,
  wrapContext,
  recipientPrivateKey,
  senderPublicKey,
  trustedSenderKeyIds,
}: {
  enc: Uint8Array
  ciphertext: Uint8Array
  wrapContext: WrapContext
  recipientPrivateKey: Uint8Array
  senderPublicKey: Uint8Array
  trustedSenderKeyIds: ReadonlySet<string>
}): Promise<Uint8Array> {
  const senderKeyId = await machineKeyId(senderPublicKey)
  if (!trustedSenderKeyIds.has(senderKeyId)) {
    throw new SecretEnvelopeError('untrusted-sender')
  }
  requireLength(enc, hpkeSuite.kem.encSize)
  requireLength(recipientPrivateKey, KEY_SIZE)

  try {
    const [recipientKey, senderKey] = await Promise.all([
      hpkeSuite.kem.deserializePrivateKey(recipientPrivateKey),
      hpkeSuite.kem.deserializePublicKey(senderPublicKey),
    ])
    const recipient = await hpkeSuite.createRecipientContext({
      recipientKey,
      senderPublicKey: senderKey,
      enc,
      info: encodeWrapContext(wrapContext),
    })
    const dek = new Uint8Array(await recipient.open(ciphertext))
    requireLength(dek, KEY_SIZE)
    return dek
  } catch (error) {
    if (error instanceof SecretEnvelopeError) throw error
    throw new SecretEnvelopeError('authentication-failed')
  }
}

export function sealValue({
  dek,
  valueContext,
  plaintext,
}: {
  dek: Uint8Array
  valueContext: ValueContext
  plaintext: Uint8Array
}): Uint8Array {
  requireLength(dek, KEY_SIZE)
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_SIZE))
  const ciphertext = xchacha20poly1305(dek, nonce, encodeValueContext(valueContext)).encrypt(
    plaintext,
  )
  const envelope = new Uint8Array(HEADER_SIZE + NONCE_SIZE + ciphertext.length)
  envelope[0] = FORMAT_VERSION
  envelope[1] = ALGORITHM_ID
  envelope.set(nonce, HEADER_SIZE)
  envelope.set(ciphertext, HEADER_SIZE + NONCE_SIZE)
  return envelope
}

export function openValue({
  envelope,
  dek,
  valueContext,
}: {
  envelope: Uint8Array
  dek: Uint8Array
  valueContext: ValueContext
}): Uint8Array {
  requireLength(dek, KEY_SIZE)
  if (envelope.length < HEADER_SIZE + NONCE_SIZE + TAG_SIZE) malformed()
  if (envelope[0] !== FORMAT_VERSION) throw new SecretEnvelopeError('unknown-version')
  if (envelope[1] !== ALGORITHM_ID) throw new SecretEnvelopeError('unknown-algorithm')

  const nonce = envelope.subarray(HEADER_SIZE, HEADER_SIZE + NONCE_SIZE)
  const ciphertext = envelope.subarray(HEADER_SIZE + NONCE_SIZE)
  try {
    return xchacha20poly1305(dek, nonce, encodeValueContext(valueContext)).decrypt(ciphertext)
  } catch (error) {
    if (error instanceof SecretEnvelopeError) throw error
    throw new SecretEnvelopeError('authentication-failed')
  }
}
