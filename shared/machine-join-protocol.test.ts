import { expect, test } from 'bun:test'
import {
  decodeMachineJoinRecord,
  encodeMachineJoinRecord,
  makeMachineJoinTag,
  openMachineJoinMessage,
  sealMachineJoinMessage,
  startMachineJoin,
  verifyMachineJoinTag,
} from './machine-join-protocol.ts'
import { generatePairingCode } from './pairing-code.ts'
import { generateMachineKeyPair } from './secret-envelope.ts'

const sideA = Uint8Array.from({ length: 16 }, (_, index) => index)
const sideB = Uint8Array.from({ length: 16 }, (_, index) => index + 16)

function sessions(code = generatePairingCode('42')) {
  const joiner = startMachineJoin(code, 'space-a', '2030-01-01T00:00:00.000Z', 'joiner', sideA)
  const approver = startMachineJoin(code, 'space-a', '2030-01-01T00:00:00.000Z', 'approver', sideB)
  return {
    joiner: joiner.finish(approver.share, approver.side),
    approver: approver.finish(joiner.share, joiner.side),
  }
}

test('both machine join roles confirm and open each other records', async () => {
  const session = sessions()
  expect(session.joiner.isk).toEqual(session.approver.isk)
  expect(
    verifyMachineJoinTag(
      session.joiner,
      'approver',
      makeMachineJoinTag(session.approver, 'approver'),
    ),
  ).toBeTrue()
  expect(
    verifyMachineJoinTag(session.approver, 'joiner', makeMachineJoinTag(session.joiner, 'joiner')),
  ).toBeTrue()

  const pair = await generateMachineKeyPair()
  const record = {
    keyId: 'key-a',
    publicKey: pair.publicKey,
    signingPublicKey: new Uint8Array(32).fill(7),
    label: 'machine a',
  }
  const sealed = sealMachineJoinMessage(
    session.joiner,
    'joiner',
    'space-a',
    '42',
    'confirm-a',
    encodeMachineJoinRecord(record),
    new Uint8Array(24),
  )
  expect(
    decodeMachineJoinRecord(
      openMachineJoinMessage(session.approver, 'joiner', 'space-a', '42', 'confirm-a', sealed),
    ),
  ).toEqual(record)
})

test('a wrong code fails both tags and both sealed records', () => {
  const code = generatePairingCode('42')
  const wrong = { ...code, secret: code.secret.map((byte, index) => byte ^ (index === 0 ? 1 : 0)) }
  const joiner = startMachineJoin(code, 'space-a', 'expiry', 'joiner', sideA)
  const approver = startMachineJoin(wrong, 'space-a', 'expiry', 'approver', sideB)
  const a = joiner.finish(approver.share, approver.side)
  const b = approver.finish(joiner.share, joiner.side)
  expect(verifyMachineJoinTag(a, 'approver', makeMachineJoinTag(b, 'approver'))).toBeFalse()
  expect(verifyMachineJoinTag(b, 'joiner', makeMachineJoinTag(a, 'joiner'))).toBeFalse()
  const sealedA = sealMachineJoinMessage(
    a,
    'joiner',
    'space-a',
    '42',
    'confirm-a',
    new Uint8Array([1]),
  )
  const sealedB = sealMachineJoinMessage(
    b,
    'approver',
    'space-a',
    '42',
    'confirm-b',
    new Uint8Array([2]),
  )
  expect(() => openMachineJoinMessage(b, 'joiner', 'space-a', '42', 'confirm-a', sealedA)).toThrow()
  expect(() =>
    openMachineJoinMessage(a, 'approver', 'space-a', '42', 'confirm-b', sealedB),
  ).toThrow()
})

test('tags bind roles and sides', () => {
  const session = sessions()
  const approverTag = makeMachineJoinTag(session.approver, 'approver')
  expect(verifyMachineJoinTag(session.joiner, 'joiner', approverTag)).toBeFalse()
  const swapped = { ...session.joiner, approverSide: session.joiner.joinerSide }
  expect(verifyMachineJoinTag(swapped, 'approver', approverTag)).toBeFalse()
})

test('machine join records refuse wrong key sizes and extra fields', async () => {
  const { encode } = await import('cbor2')
  expect(() =>
    decodeMachineJoinRecord(
      encode(
        new Map([
          [1, 'key'],
          [2, new Uint8Array(31)],
          [3, new Uint8Array(32)],
          [4, 'label'],
        ]),
        {
          dcbor: true,
          rejectDuplicateKeys: true,
          preferMap: true,
        },
      ),
    ),
  ).toThrow('public key')
  expect(() =>
    decodeMachineJoinRecord(
      encode(
        new Map([
          [1, 'key'],
          [2, new Uint8Array(32)],
          [3, new Uint8Array(32)],
          [4, 'label'],
          [5, 1],
        ]),
        {
          dcbor: true,
          rejectDuplicateKeys: true,
          preferMap: true,
        },
      ),
    ),
  ).toThrow('extra or missing')
})
