import { describe, expect, test } from 'bun:test'
import { sha512 } from '@noble/hashes/sha2.js'
import { CpaceRefusal, type CpaceRefusalCause, startCpace, startCpaceWithScalar } from './cpace.ts'

const B_3_9 = {
  PRS: '50617373776F7264',
  CI: '0B415F696E69746961746F720B425F726573706F6E646572',
  sid: '7E4B4791D6A8EF019B936C79FB7F2C57',
  g: '222B6B195FE84B1652BADB6F6A3AE3D24341E7306967F0B8115B40D5698C7E56',
  ya: 'DA3D23700A9E5699258AEF94DC060DFDA5EBB61F02A5EA77FAD53F4FF0976D08',
  ADa: '414461',
  Ya: 'D6BAC480F2C386C394EFC7C47ADB9925DCD2630B64F240C50F8D0EEC482B9157',
  yb: 'D2316B454718C35362D83D69DF6320F38578ED5984651435E2949762D900B80D',
  ADb: '414462',
  Yb: '3EA7E0B19560D7C0B0F5734F63B955286DFA8232B5EBE63324E2D9E7433F7258',
  K: '80B69A8A76457AB6A4D7F887A4BF6B55A2F80AC19C333F917A05FC9887C8B40F',
  ISK_IR:
    'B69EFFBF61B51D56401C0F65601ABE428DE8206FEAAF0E32198896DCAE7B35CD2B38950A39DFD5D4A79164614C2984F7DAA460B588C1E80C3FA2068AF7900447',
  ISK_SY:
    '544199D71F62F8D9A1FEE55727E24FE4A45844593C2B6013C4FA3969D0E5DEBB2244675C0B43397CBB68D342B01FC0F98FC961469A25134DE9F0F813C1A57476',
  sid_output_ir:
    'BB1C449B35F0EA79A65C209F329A693D475E0CE2387BED9FE4B78F60B2A27C219813FB2CFE175EF40D2222D9261E66DA7D78F7C55A303B1B8611DCDFAB880C47',
  sid_output_oc:
    '10D5941D4933497FE31B9188D690B84465E2A2D158332A7267284A071A8D0876FC5C8C329DC735D59A9F8EF6623EE23924704A2F929DD631CA981227EE82FFF2',
} as const

const B_3_11_1 = {
  Valid: {
    s: '7CD0E075FA7955BA52C02759A6C90DBBFC10E6D40AEA8D283E407D88CF538A05',
    X: '2C3C6B8C4F3800E7AEF6864025B4ED79BD599117E427C41BD47D93D654B4A51C',
    'G.scalar_mult(s,decode(X))':
      '7C13645FE790A468F62C39BEB7388E541D8405D1ADE69D1778C5FE3E7F6B600E',
    'G.scalar_mult_vfy(s,X)': '7C13645FE790A468F62C39BEB7388E541D8405D1ADE69D1778C5FE3E7F6B600E',
  },
  'Invalid Y1': '2B3C6B8C4F3800E7AEF6864025B4ED79BD599117E427C41BD47D93D654B4A51C',
  'Invalid Y2': '0000000000000000000000000000000000000000000000000000000000000000',
} as const

const textEncoder = new TextEncoder()

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

function prependLength(value: Uint8Array): Uint8Array {
  if (value.length >= 128) throw new Error('test helper only supports short values')
  return Uint8Array.of(value.length, ...value)
}

function concatenate(...values: Uint8Array[]): Uint8Array {
  return Uint8Array.from(values.flatMap((value) => Array.from(value)))
}

function expectRefusal(action: () => unknown, cause: CpaceRefusalCause): void {
  try {
    action()
    throw new Error('expected CPace refusal')
  } catch (error) {
    expect(error).toBeInstanceOf(CpaceRefusal)
    expect((error as CpaceRefusal).cause).toBe(cause)
  }
}

const vectorInputs = {
  prs: bytes(B_3_9.PRS),
  ci: bytes(B_3_9.CI),
  sid: bytes(B_3_9.sid),
}

describe('CPace draft vectors', () => {
  test('reproduces the generator, shares, and initiator-responder ISK', () => {
    const one = new Uint8Array(32)
    one[0] = 1
    const generator = startCpaceWithScalar(
      'initiator',
      { ...vectorInputs, ad: new Uint8Array() },
      one,
    )
    expect(hex(generator.share)).toBe(B_3_9.g)

    const initiator = startCpaceWithScalar(
      'initiator',
      { ...vectorInputs, ad: bytes(B_3_9.ADa) },
      bytes(B_3_9.ya),
    )
    const responder = startCpaceWithScalar(
      'responder',
      { ...vectorInputs, ad: bytes(B_3_9.ADb) },
      bytes(B_3_9.yb),
    )

    expect(hex(initiator.share)).toBe(B_3_9.Ya)
    expect(hex(responder.share)).toBe(B_3_9.Yb)
    expect(hex(initiator.finish(responder.share, bytes(B_3_9.ADb)))).toBe(B_3_9.ISK_IR)
    expect(hex(responder.finish(initiator.share, bytes(B_3_9.ADa)))).toBe(B_3_9.ISK_IR)
  })

  test('verifies the valid scalar multiplication case', () => {
    const inputs = {
      prs: textEncoder.encode('valid-point-test'),
      ci: new Uint8Array(),
      sid: new Uint8Array(),
      ad: new Uint8Array(),
    }
    const party = startCpaceWithScalar('initiator', inputs, bytes(B_3_11_1.Valid.s))
    const peerShare = bytes(B_3_11_1.Valid.X)
    const expectedProduct = bytes(B_3_11_1.Valid['G.scalar_mult_vfy(s,X)'])
    const dsi = textEncoder.encode('CPaceRistretto255_ISK')
    const expected = sha512(
      concatenate(
        prependLength(dsi),
        prependLength(inputs.sid),
        prependLength(expectedProduct),
        prependLength(party.share),
        prependLength(inputs.ad),
        prependLength(peerShare),
        prependLength(new Uint8Array()),
      ),
    )

    expect(party.finish(peerShare, new Uint8Array())).toEqual(expected)
  })

  test('refuses the draft invalid encodings by cause', () => {
    const inputs = { ...vectorInputs, ad: bytes(B_3_9.ADa) }
    expectRefusal(
      () =>
        startCpaceWithScalar('initiator', inputs, bytes(B_3_11_1.Valid.s)).finish(
          bytes(B_3_11_1['Invalid Y1']),
          new Uint8Array(),
        ),
      'undecodable-share',
    )
    expectRefusal(
      () =>
        startCpaceWithScalar('initiator', inputs, bytes(B_3_11_1.Valid.s)).finish(
          bytes(B_3_11_1['Invalid Y2']),
          new Uint8Array(),
        ),
      'identity-share',
    )
  })
})

describe('CPace exchange', () => {
  test('random parties derive the same ISK and a different password does not', () => {
    const common = {
      ci: textEncoder.encode('pairing-channel'),
      sid: textEncoder.encode('relay-session'),
    }
    const initiator = startCpace('initiator', {
      ...common,
      prs: textEncoder.encode('same password'),
      ad: textEncoder.encode('initiator'),
    })
    const responder = startCpace('responder', {
      ...common,
      prs: textEncoder.encode('same password'),
      ad: textEncoder.encode('responder'),
    })
    const different = startCpace('responder', {
      ...common,
      prs: textEncoder.encode('different password'),
      ad: textEncoder.encode('responder'),
    })

    const initiatorKey = initiator.finish(responder.share, textEncoder.encode('responder'))
    const responderKey = responder.finish(initiator.share, textEncoder.encode('initiator'))
    const differentKey = different.finish(initiator.share, textEncoder.encode('initiator'))
    expect(initiatorKey).toEqual(responderKey)
    expect(differentKey).not.toEqual(initiatorKey)
    expect(() => initiator.finish(responder.share, textEncoder.encode('responder'))).toThrow(
      'CPace exchange is already finished',
    )
  })
})
