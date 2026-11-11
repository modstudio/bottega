// concern: CPace-ristretto255-SHA512

import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js'
import { sha512 } from '@noble/hashes/sha2.js'

const textEncoder = new TextEncoder()
const DSI = textEncoder.encode('CPaceRistretto255')
const DSI_ISK = textEncoder.encode('CPaceRistretto255_ISK')
const SHA512_BLOCK_SIZE = 128
const SCALAR_SIZE = 32

export type CpaceRole = 'initiator' | 'responder'

export interface CpaceInputs {
  prs: Uint8Array
  ci: Uint8Array
  sid: Uint8Array
  ad: Uint8Array
}

export interface CpaceParty {
  readonly share: Uint8Array
  finish(peerShare: Uint8Array, peerAd: Uint8Array): Uint8Array
}

export type CpaceRefusalCause = 'undecodable-share' | 'identity-share'

export class CpaceRefusal extends Error {
  override readonly cause: CpaceRefusalCause

  constructor(cause: CpaceRefusalCause) {
    super(`CPace refused the peer's ${cause}`)
    this.name = 'CpaceRefusal'
    this.cause = cause
  }
}

function concatenate(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((length, value) => length + value.length, 0))
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.length
  }
  return result
}

function prependLength(value: Uint8Array): Uint8Array {
  const lengthBytes: number[] = []
  let length = value.length
  do {
    const remaining = length >>> 7
    lengthBytes.push((length & 0x7f) | (remaining === 0 ? 0 : 0x80))
    length = remaining
  } while (length !== 0)
  return concatenate(Uint8Array.from(lengthBytes), value)
}

function lengthValueConcatenate(...values: Uint8Array[]): Uint8Array {
  return concatenate(...values.map(prependLength))
}

function generatorString(inputs: CpaceInputs): Uint8Array {
  const paddingLength = Math.max(
    0,
    SHA512_BLOCK_SIZE - prependLength(inputs.prs).length - prependLength(DSI).length - 1,
  )
  return lengthValueConcatenate(
    DSI,
    inputs.prs,
    new Uint8Array(paddingLength),
    inputs.ci,
    inputs.sid,
  )
}

function calculateGenerator(inputs: CpaceInputs): InstanceType<typeof ristretto255.Point> {
  return ristretto255_hasher.deriveToCurve!(sha512(generatorString(inputs)))
}

function scalarFromBytes(bytes: Uint8Array): bigint {
  if (bytes.length !== SCALAR_SIZE) {
    throw new Error(`CPace scalar must be exactly ${SCALAR_SIZE} bytes`)
  }
  let scalar = 0n
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    scalar = (scalar << 8n) | BigInt(bytes[index]!)
  }
  return scalar
}

function transcriptIr(
  initiatorShare: Uint8Array,
  initiatorAd: Uint8Array,
  responderShare: Uint8Array,
  responderAd: Uint8Array,
): Uint8Array {
  return concatenate(
    lengthValueConcatenate(initiatorShare, initiatorAd),
    lengthValueConcatenate(responderShare, responderAd),
  )
}

function verifiedProduct(scalar: bigint, peerShare: Uint8Array): Uint8Array {
  let peerPoint: InstanceType<typeof ristretto255.Point>
  try {
    peerPoint = ristretto255.Point.fromBytes(peerShare)
  } catch {
    throw new CpaceRefusal('undecodable-share')
  }
  if (peerPoint.is0()) {
    throw new CpaceRefusal('identity-share')
  }
  const product = peerPoint.multiply(scalar)
  if (product.is0()) {
    throw new CpaceRefusal('identity-share')
  }
  return product.toBytes()
}

/** Test seam for draft vectors. Production callers use startCpace. */
export function startCpaceWithScalar(
  role: CpaceRole,
  inputs: CpaceInputs,
  scalarBytes: Uint8Array,
): CpaceParty {
  const scalar = scalarFromBytes(scalarBytes)
  const share = calculateGenerator(inputs).multiply(scalar).toBytes()
  let finished = false

  return {
    share,
    finish(peerShare: Uint8Array, peerAd: Uint8Array): Uint8Array {
      if (finished) {
        throw new Error('CPace exchange is already finished')
      }
      finished = true
      const sharedPoint = verifiedProduct(scalar, peerShare)
      const [initiatorShare, initiatorAd, responderShare, responderAd] =
        role === 'initiator'
          ? [share, inputs.ad, peerShare, peerAd]
          : [peerShare, peerAd, share, inputs.ad]
      return sha512(
        concatenate(
          lengthValueConcatenate(DSI_ISK, inputs.sid, sharedPoint),
          transcriptIr(initiatorShare, initiatorAd, responderShare, responderAd),
        ),
      )
    },
  }
}

export function startCpace(role: CpaceRole, inputs: CpaceInputs): CpaceParty {
  const scalar = crypto.getRandomValues(new Uint8Array(SCALAR_SIZE))
  scalar[SCALAR_SIZE - 1] = scalar[SCALAR_SIZE - 1]! & 0x0f
  return startCpaceWithScalar(role, inputs, scalar)
}
