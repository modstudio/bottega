// concern: machine join authenticated exchange protocol

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { decode, encode } from 'cbor2'
import { PLATFORM_SLUG } from './brand.ts'
import { type CpaceParty, type CpaceRole, lengthValueConcatenate, startCpace } from './cpace.ts'
import { type PairingCode, pairingPassword } from './pairing-code.ts'
import { decodeTrustLogKey, encodeTrustLogKey, type TrustLogKey } from './trust-log.ts'

const utf8 = (value: string) => new TextEncoder().encode(value)
const concat = (...values: Uint8Array[]) => {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0))
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.length
  }
  return result
}
const dcbor = { dcbor: true, rejectDuplicateKeys: true, preferMap: true } as const
const PROTOCOL = `${PLATFORM_SLUG} machine join v1`
const SIDE_BYTES = 16
const TAG_BYTES = 64
const NONCE_BYTES = 24

export type MachineJoinRole = 'joiner' | 'approver'
export type MachineJoinSession = {
  sid: Uint8Array
  isk: Uint8Array
  joinerShare: Uint8Array
  approverShare: Uint8Array
  joinerSide: Uint8Array
  approverSide: Uint8Array
  joinerSealKey: Uint8Array
  approverSealKey: Uint8Array
}

export type MachineJoinParty = {
  side: Uint8Array
  share: Uint8Array
  finish(peerShare: Uint8Array, peerSide: Uint8Array): MachineJoinSession
}

function machineJoinSid(spaceId: string, nameplate: string, expiresAt: string): Uint8Array {
  return sha256(
    lengthValueConcatenate(
      utf8(`${PROTOCOL} sid`),
      utf8(spaceId),
      utf8(nameplate),
      utf8(expiresAt),
    ),
  )
}

export function startMachineJoin(
  code: PairingCode,
  spaceId: string,
  expiresAt: string,
  role: MachineJoinRole,
  side = crypto.getRandomValues(new Uint8Array(SIDE_BYTES)),
): MachineJoinParty {
  if (side.byteLength !== SIDE_BYTES) throw new Error('machine join side must be exactly 16 bytes')
  const sid = machineJoinSid(spaceId, code.nameplate, expiresAt)
  const cpaceRole: CpaceRole = role === 'joiner' ? 'initiator' : 'responder'
  const party: CpaceParty = startCpace(cpaceRole, {
    prs: pairingPassword(code),
    ci: lengthValueConcatenate(utf8(PROTOCOL), utf8(spaceId)),
    sid,
    ad: side,
  })
  return {
    side: side.slice(),
    share: party.share,
    finish(peerShare, peerSide) {
      if (peerSide.byteLength !== SIDE_BYTES)
        throw new Error('machine join peer side must be exactly 16 bytes')
      const isk = party.finish(peerShare, peerSide)
      const [joinerShare, approverShare, joinerSide, approverSide] =
        role === 'joiner'
          ? [party.share, peerShare, side, peerSide]
          : [peerShare, party.share, peerSide, side]
      return {
        sid,
        isk,
        joinerShare,
        approverShare,
        joinerSide,
        approverSide,
        joinerSealKey: hkdf(sha512, isk, sid, utf8(`${PROTOCOL} joiner`), 32),
        approverSealKey: hkdf(sha512, isk, sid, utf8(`${PROTOCOL} approver`), 32),
      }
    },
  }
}

export function makeMachineJoinTag(session: MachineJoinSession, role: MachineJoinRole): Uint8Array {
  const macKey = sha512(concat(utf8('CPaceMac'), session.sid, session.isk))
  const [share, side] =
    role === 'joiner'
      ? [session.joinerShare, session.joinerSide]
      : [session.approverShare, session.approverSide]
  return hmac(sha512, macKey, lengthValueConcatenate(share, side))
}

export function verifyMachineJoinTag(
  session: MachineJoinSession,
  role: MachineJoinRole,
  actual: Uint8Array,
): boolean {
  const expected = makeMachineJoinTag(session, role)
  let difference = expected.byteLength ^ actual.byteLength
  for (let index = 0; index < expected.byteLength; index += 1)
    difference |= expected[index]! ^ (actual[index] ?? 0)
  return difference === 0
}

function sealKey(session: MachineJoinSession, role: MachineJoinRole): Uint8Array {
  return role === 'joiner' ? session.joinerSealKey : session.approverSealKey
}

function aad(spaceId: string, nameplate: string, phase: string): Uint8Array {
  return lengthValueConcatenate(utf8(spaceId), utf8(nameplate), utf8(phase))
}

export function sealMachineJoinMessage(
  session: MachineJoinSession,
  role: MachineJoinRole,
  spaceId: string,
  nameplate: string,
  phase: string,
  plaintext: Uint8Array,
  nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES)),
): Uint8Array {
  if (nonce.byteLength !== NONCE_BYTES)
    throw new Error('machine join nonce must be exactly 24 bytes')
  return concat(
    nonce,
    xchacha20poly1305(sealKey(session, role), nonce, aad(spaceId, nameplate, phase)).encrypt(
      plaintext,
    ),
  )
}

export function openMachineJoinMessage(
  session: MachineJoinSession,
  role: MachineJoinRole,
  spaceId: string,
  nameplate: string,
  phase: string,
  sealed: Uint8Array,
): Uint8Array {
  if (sealed.byteLength < NONCE_BYTES + 16)
    throw new Error('machine join sealed message is too short')
  const nonce = sealed.slice(0, NONCE_BYTES)
  return xchacha20poly1305(sealKey(session, role), nonce, aad(spaceId, nameplate, phase)).decrypt(
    sealed.slice(NONCE_BYTES),
  )
}

export function encodeMachineJoinRecord(record: TrustLogKey): Uint8Array {
  return encodeTrustLogKey(record)
}

export function decodeMachineJoinRecord(encoded: Uint8Array): TrustLogKey {
  try {
    return decodeTrustLogKey(encoded)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('key.publicKey'))
      throw new Error('machine join record public key must be exactly 32 bytes', { cause: error })
    if (message.includes('key.signingPublicKey'))
      throw new Error('machine join record signing public key must be exactly 32 bytes', {
        cause: error,
      })
    if (message.includes('extra field') || message.includes('is missing'))
      throw new Error('machine join record has an extra or missing field', { cause: error })
    throw error
  }
}

export function encodeMachineJoinDone(head: Uint8Array | null): Uint8Array {
  if (head !== null && head.byteLength !== 32)
    throw new Error('machine join trust-log head must be exactly 32 bytes')
  return encode(new Map<number, unknown>([[1, head]]), dcbor)
}

export function decodeMachineJoinDone(encoded: Uint8Array): Uint8Array | null {
  const value = decode(encoded, dcbor)
  if (!(value instanceof Map) || value.size !== 1 || !value.has(1))
    throw new Error('machine join done message is invalid')
  const head = value.get(1)
  if (head !== null && (!(head instanceof Uint8Array) || head.byteLength !== 32))
    throw new Error('machine join done head must be null or exactly 32 bytes')
  return head
}

export const MACHINE_JOIN_TAG_BYTES = TAG_BYTES
