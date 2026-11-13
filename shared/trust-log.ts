import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { decode, encode } from 'cbor2'

const TRUST_LOG_KINDS = ['genesis', 'add', 'remove', 'revoke'] as const
export type TrustLogKey = {
  keyId: string
  publicKey: Uint8Array
  signingPublicKey: Uint8Array
  label: string
}
export type TrustLogBody =
  | { kind: 'genesis'; first: TrustLogKey; recoveryPublicKey: Uint8Array }
  | ({ kind: 'add' } & TrustLogKey)
  | { kind: 'remove' | 'revoke'; keyId: string }
export type UnsignedTrustLogEntry = {
  prev: Uint8Array | null
  space: string
  body: TrustLogBody
  signer: Uint8Array
  at: number
}
export type TrustLogEntry = UnsignedTrustLogEntry & { sig: Uint8Array }
export type TrustState = {
  head: Uint8Array
  keys: Map<string, TrustLogKey>
  recoveryPublicKey: Uint8Array
}

const dcbor = { dcbor: true, rejectDuplicateKeys: true, preferMap: true } as const
export const bytesEqual = (left: Uint8Array, right: Uint8Array) =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index])

function keyBody(key: TrustLogKey): Map<number, unknown> {
  return new Map<number, unknown>([
    [1, key.keyId],
    [2, key.publicKey],
    [3, key.signingPublicKey],
    [4, key.label],
  ])
}

function entryMap(entry: UnsignedTrustLogEntry, sig?: Uint8Array): Map<number, unknown> {
  const body =
    entry.body.kind === 'genesis'
      ? new Map<number, unknown>([
          [1, keyBody(entry.body.first)],
          [2, entry.body.recoveryPublicKey],
        ])
      : entry.body.kind === 'add'
        ? keyBody(entry.body)
        : new Map<number, unknown>([[1, entry.body.keyId]])
  const map = new Map<number, unknown>([
    [1, TRUST_LOG_KINDS.indexOf(entry.body.kind)],
    [2, entry.prev],
    [3, entry.space],
    [4, body],
    [5, entry.signer],
    [6, entry.at],
  ])
  if (sig) map.set(7, sig)
  return map
}

export function encodeTrustLogEntry(entry: TrustLogEntry): Uint8Array {
  return encode(entryMap(entry, entry.sig), dcbor)
}

function field(map: Map<unknown, unknown>, key: number, name: string): unknown {
  if (!map.has(key)) throw new Error(`trust log entry field ${name} is missing`)
  return map.get(key)
}

function exactMap(value: unknown, keys: readonly number[], name: string): Map<unknown, unknown> {
  if (!(value instanceof Map)) throw new Error(`trust log entry field ${name} must be a map`)
  for (const key of value.keys())
    if (typeof key !== 'number' || !keys.includes(key))
      throw new Error(`trust log entry field ${name} has an extra field`)
  for (const key of keys)
    if (!value.has(key)) throw new Error(`trust log entry field ${name}.${key} is missing`)
  return value
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`trust log entry field ${name} must be text`)
  return value
}

function bytes(value: unknown, length: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length)
    throw new Error(`trust log entry field ${name} must be a ${length}-byte byte string`)
  return value
}

function uint(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`trust log entry field ${name} must be an unsigned integer`)
  return value
}

function parseKey(value: unknown, name: string): TrustLogKey {
  const map = exactMap(value, [1, 2, 3, 4], name)
  return {
    keyId: text(field(map, 1, `${name}.keyId`), `${name}.keyId`),
    publicKey: bytes(field(map, 2, `${name}.publicKey`), 32, `${name}.publicKey`),
    signingPublicKey: bytes(
      field(map, 3, `${name}.signingPublicKey`),
      32,
      `${name}.signingPublicKey`,
    ),
    label: text(field(map, 4, `${name}.label`), `${name}.label`),
  }
}

export function decodeTrustLogEntry(encoded: Uint8Array): TrustLogEntry {
  let decoded: unknown
  try {
    decoded = decode(encoded, dcbor)
  } catch (error) {
    throw new Error(
      `trust log entry encoding is invalid: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const map = exactMap(decoded, [1, 2, 3, 4, 5, 6, 7], 'entry')
  const kindNumber = uint(field(map, 1, 'kind'), 'kind')
  const kind = TRUST_LOG_KINDS[kindNumber]
  if (!kind) throw new Error('trust log entry field kind is unknown')
  const prevValue = field(map, 2, 'prev')
  const prev = prevValue === null ? null : bytes(prevValue, 32, 'prev')
  if ((kind === 'genesis') !== (prev === null))
    throw new Error('trust log entry field prev must be null for genesis only')
  const bodyMap = field(map, 4, 'body')
  let body: TrustLogBody
  if (kind === 'genesis') {
    const genesis = exactMap(bodyMap, [1, 2], 'body')
    body = {
      kind,
      first: parseKey(field(genesis, 1, 'body.first'), 'body.first'),
      recoveryPublicKey: bytes(
        field(genesis, 2, 'body.recoveryPublicKey'),
        32,
        'body.recoveryPublicKey',
      ),
    }
  } else if (kind === 'add') {
    body = { kind, ...parseKey(bodyMap, 'body') }
  } else {
    const removal = exactMap(bodyMap, [1], 'body')
    body = { kind, keyId: text(field(removal, 1, 'body.keyId'), 'body.keyId') }
  }
  const result: TrustLogEntry = {
    prev,
    space: text(field(map, 3, 'space'), 'space'),
    body,
    signer: bytes(field(map, 5, 'signer'), 32, 'signer'),
    at: uint(field(map, 6, 'at'), 'at'),
    sig: bytes(field(map, 7, 'sig'), 64, 'sig'),
  }
  if (!bytesEqual(encodeTrustLogEntry(result), encoded))
    throw new Error('trust log entry encoding is non-canonical')
  return result
}

export function trustLogEntryHash(encoded: Uint8Array): Uint8Array {
  return sha256(encoded)
}

export function signTrustLogEntry(
  unsigned: UnsignedTrustLogEntry,
  signingPrivateKey: Uint8Array,
): Uint8Array {
  const sig = ed25519.sign(sha256(encode(entryMap(unsigned), dcbor)), signingPrivateKey)
  return encodeTrustLogEntry({ ...unsigned, sig })
}

function signerAllowed(entry: TrustLogEntry, keys: Map<string, TrustLogKey>, recovery: Uint8Array) {
  if (entry.body.kind === 'add' && bytesEqual(entry.signer, recovery)) return true
  return [...keys.values()].some((key) => bytesEqual(key.signingPublicKey, entry.signer))
}

function verificationFailure(index: number, rule: string): never {
  throw new Error(`trust log entry index ${index} violates ${rule}`)
}

function validSignature(entry: TrustLogEntry): boolean {
  return ed25519.verify(entry.sig, sha256(encode(entryMap(entry), dcbor)), entry.signer)
}

function verifyGenesis(entry: TrustLogEntry, index: number, keys: Map<string, TrustLogKey>) {
  if (entry.body.kind !== 'genesis') verificationFailure(index, 'entry 0 must be genesis')
  if (!bytesEqual(entry.signer, entry.body.first.signingPublicKey))
    verificationFailure(index, 'genesis signer must be the first machine signing key')
  if (!validSignature(entry)) verificationFailure(index, 'the signature rule')
  keys.set(entry.body.first.keyId, entry.body.first)
  return entry.body.recoveryPublicKey
}

function verifyLaterEntry(
  entry: TrustLogEntry,
  index: number,
  previousHash: Uint8Array,
  keys: Map<string, TrustLogKey>,
  recovery: Uint8Array,
): void {
  if (entry.body.kind === 'genesis')
    verificationFailure(index, 'genesis may appear only at entry 0')
  if (!entry.prev || !bytesEqual(entry.prev, previousHash))
    verificationFailure(index, 'the previous hash rule')
  if (!signerAllowed(entry, keys, recovery)) verificationFailure(index, 'the signer authority rule')
  if (!validSignature(entry)) verificationFailure(index, 'the signature rule')
  if (entry.body.kind === 'add') {
    const added = entry.body
    if (keys.has(added.keyId)) verificationFailure(index, 'add keyId must not already be trusted')
    if ([...keys.values()].some((key) => bytesEqual(key.signingPublicKey, added.signingPublicKey)))
      verificationFailure(index, 'trusted machines must not share a signing key')
    keys.set(added.keyId, added)
    return
  }
  if (bytesEqual(entry.signer, recovery))
    verificationFailure(index, 'the recovery key may sign only add')
  if (!keys.has(entry.body.keyId))
    verificationFailure(index, `${entry.body.kind} keyId must be trusted`)
  keys.delete(entry.body.keyId)
}

export function verifyTrustLog(
  encodedEntries: readonly Uint8Array[],
  options: { spaceId: string; rememberedHead?: Uint8Array | null },
): TrustState {
  if (encodedEntries.length === 0) throw new Error('trust log must be non-empty at entry index 0')
  const entries = encodedEntries.map((encoded, index) => {
    try {
      return decodeTrustLogEntry(encoded)
    } catch (error) {
      throw new Error(
        `trust log entry index ${index} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })
  const hashes = encodedEntries.map(trustLogEntryHash)
  const rememberedHead = options.rememberedHead
  if (rememberedHead && !hashes.some((hash) => bytesEqual(hash, rememberedHead)))
    throw new Error(
      'trust log fork or rollback: the log does not extend the head this machine last accepted; stop, do not trust this record, and report it',
    )
  const keys = new Map<string, TrustLogKey>()
  let recovery: Uint8Array = new Uint8Array()
  for (const [index, entry] of entries.entries()) {
    if (entry.space !== options.spaceId) verificationFailure(index, 'the space rule')
    if (index === 0) recovery = verifyGenesis(entry, index, keys)
    else verifyLaterEntry(entry, index, hashes[index - 1]!, keys, recovery)
  }
  return { head: hashes.at(-1)!, keys, recoveryPublicKey: recovery }
}
