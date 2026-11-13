import { expect, test } from 'bun:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { encode } from 'cbor2'
import {
  decodeTrustLogEntry,
  signTrustLogEntry,
  type TrustLogKey,
  trustLogEntryHash,
  verifyTrustLog,
} from './trust-log.ts'

const privateKey = (value: number) => new Uint8Array(32).fill(value)
const machine = (keyId: string, value: number): TrustLogKey => ({
  keyId,
  publicKey: new Uint8Array(32).fill(value + 10),
  signingPublicKey: ed25519.getPublicKey(privateKey(value)),
  label: `machine-${value}`,
})
const space = '01990000-0000-7000-8000-000000000001'
const first = machine('first-key', 1)
const second = machine('second-key', 2)
const third = machine('third-key', 3)
const recoveryPrivate = privateKey(4)
const recoveryPublic = ed25519.getPublicKey(recoveryPrivate)

function signed(
  body:
    | { kind: 'genesis'; first: TrustLogKey; recoveryPublicKey: Uint8Array }
    | ({ kind: 'add' } & TrustLogKey)
    | { kind: 'remove' | 'revoke'; keyId: string },
  prev: Uint8Array | null,
  signer: Uint8Array,
  at: number,
) {
  return signTrustLogEntry({ prev, space, body, signer: ed25519.getPublicKey(signer), at }, signer)
}

function chain() {
  const genesis = signed(
    { kind: 'genesis', first, recoveryPublicKey: recoveryPublic },
    null,
    privateKey(1),
    1,
  )
  const addSecond = signed({ kind: 'add', ...second }, trustLogEntryHash(genesis), privateKey(1), 2)
  const addThird = signed(
    { kind: 'add', ...third },
    trustLogEntryHash(addSecond),
    recoveryPrivate,
    3,
  )
  const revokeSecond = signed(
    { kind: 'revoke', keyId: second.keyId },
    trustLogEntryHash(addThird),
    privateKey(1),
    4,
  )
  return [genesis, addSecond, addThird, revokeSecond]
}

test('fixed trust log entry has a stable dCBOR encoding and hash', () => {
  const entry = chain()[0]!
  expect(Buffer.from(entry).toString('hex')).toBe(
    'a7010002f603782430313939303030302d303030302d373030302d383030302d30303030303030303030303104a201a4016966697273742d6b65790258200b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0358208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c04696d616368696e652d31025820ca93ac1705187071d67b83c7ff0efe8108e8ec4530575d7726879333dbdabe7c0558208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c0601075840c9abd2814bb8b85229b055d85ce40e2b2255dfec7c5d639ef238fb1cdcca8a9e277ad4cf0cebe8fed8905354de80e9f1f7e9435759e8846c16caccd7c4b33d0d',
  )
  expect(Buffer.from(trustLogEntryHash(entry)).toString('hex')).toBe(
    '37f3169a55947b6c7a530e9277ff1a26075e2effcd8ee5cd97cac0ee68cc7ba9',
  )
})

test('genesis, member add, recovery add and revoke establish the expected trust set', () => {
  const result = verifyTrustLog(chain(), { spaceId: space })
  expect([...result.keys.keys()]).toEqual([first.keyId, third.keyId])
  expect(result.recoveryPublicKey).toEqual(recoveryPublic)
})

test('refuses a body tamper that breaks the signature', () => {
  const entries = chain()
  const tampered = entries[1]!.slice()
  const index = Buffer.from(tampered).indexOf('machine-2')
  tampered[index] ^= 1
  expect(() => verifyTrustLog(entries.with(1, tampered), { spaceId: space })).toThrow(
    'index 1 violates the signature rule',
  )
})

test('refuses reordered entries and a wrong previous hash', () => {
  const entries = chain()
  expect(() => verifyTrustLog([entries[0]!, entries[2]!, entries[1]!], { spaceId: space })).toThrow(
    'index 1 violates the previous hash rule',
  )
  const decoded = decodeTrustLogEntry(entries[1]!)
  const wrong = signTrustLogEntry({ ...decoded, prev: new Uint8Array(32) }, privateKey(1))
  expect(() => verifyTrustLog([entries[0]!, wrong], { spaceId: space })).toThrow(
    'index 1 violates the previous hash rule',
  )
})

test('refuses a second genesis', () => {
  const genesis = chain()[0]!
  expect(() => verifyTrustLog([genesis, genesis], { spaceId: space })).toThrow(
    'index 1 violates genesis may appear only',
  )
})

test('refuses add by a non-member and revoke by recovery', () => {
  const genesis = chain()[0]!
  const outsider = signed({ kind: 'add', ...second }, trustLogEntryHash(genesis), privateKey(9), 2)
  expect(() => verifyTrustLog([genesis, outsider], { spaceId: space })).toThrow('signer authority')
  const recoveryRevoke = signed(
    { kind: 'revoke', keyId: first.keyId },
    trustLogEntryHash(genesis),
    recoveryPrivate,
    2,
  )
  expect(() => verifyTrustLog([genesis, recoveryRevoke], { spaceId: space })).toThrow(
    'signer authority',
  )
})

test('refuses duplicate add and untrusted revoke', () => {
  const genesis = chain()[0]!
  const duplicate = signed({ kind: 'add', ...first }, trustLogEntryHash(genesis), privateKey(1), 2)
  expect(() => verifyTrustLog([genesis, duplicate], { spaceId: space })).toThrow(
    'already be trusted',
  )
  const absent = signed(
    { kind: 'revoke', keyId: 'absent' },
    trustLogEntryHash(genesis),
    privateKey(1),
    2,
  )
  expect(() => verifyTrustLog([genesis, absent], { spaceId: space })).toThrow(
    'keyId must be trusted',
  )
})

test('refuses the wrong space', () => {
  expect(() => verifyTrustLog(chain(), { spaceId: 'other-space' })).toThrow(
    'index 0 violates the space rule',
  )
})

test('refuses duplicate keys and non-canonical encoding', () => {
  expect(() => decodeTrustLogEntry(new Uint8Array([0xa2, 0x01, 0x00, 0x01, 0x00]))).toThrow(
    /duplicate|invalid/i,
  )
  const canonical = chain()[0]!
  expect(canonical[0]).toBe(0xa7)
  const nonCanonical = new Uint8Array(canonical.length + 1)
  nonCanonical[0] = canonical[0]!
  nonCanonical[1] = 0x18
  nonCanonical[2] = canonical[1]!
  nonCanonical.set(canonical.subarray(2), 3)
  expect(() => decodeTrustLogEntry(nonCanonical)).toThrow(/non-canonical|invalid/i)
})

test('remembered head accepts an earlier entry and refuses an absent fork head', () => {
  const entries = chain()
  expect(
    verifyTrustLog(entries, { spaceId: space, rememberedHead: trustLogEntryHash(entries[1]!) })
      .head,
  ).toEqual(trustLogEntryHash(entries.at(-1)!))
  expect(() =>
    verifyTrustLog(entries, { spaceId: space, rememberedHead: new Uint8Array(32).fill(99) }),
  ).toThrow('stop, do not trust this record, and report it')
})

test('decoder refuses an extra field', () => {
  const decoded = decodeTrustLogEntry(chain()[0]!)
  const extra = new Map<number, unknown>([
    [1, 0],
    [2, null],
    [3, decoded.space],
    [4, new Map()],
    [5, decoded.signer],
    [6, decoded.at],
    [7, decoded.sig],
    [8, 0],
  ])
  expect(() => decodeTrustLogEntry(encode(extra, { dcbor: true }))).toThrow('extra field')
})
