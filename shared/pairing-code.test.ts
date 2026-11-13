import { describe, expect, test } from 'bun:test'
import {
  formatPairingCode,
  generatePairingCode,
  NAMEPLATE_MAX,
  NAMEPLATE_PATTERN,
  PairingCodeRefusal,
  pairingPassword,
  parsePairingCode,
} from './pairing-code.ts'

function expectRefusal(action: () => unknown, message: string): void {
  expect(action).toThrow(PairingCodeRefusal)
  expect(action).toThrow(message)
}

describe('pairing code word encoding', () => {
  test('round-trips every byte through even and odd positions', () => {
    for (let byte = 0; byte <= 255; byte += 1) {
      const code = { nameplate: '42', secret: Uint8Array.of(byte, byte, byte, byte) }
      expect(parsePairingCode(formatPairingCode(code))).toEqual(code)
    }
  })

  test('accepts case and mixed separator variants', () => {
    expect(parsePairingCode('  42 Aardvark ADROITNESS-absurd   adviser ')).toEqual({
      nameplate: '42',
      secret: Uint8Array.of(0, 0, 1, 1),
    })
  })

  test('refuses a word from the other list and names its position', () => {
    expectRefusal(
      () => parsePairingCode('42 aardvark aardvark accrue aftermath'),
      'word 2 "aardvark" belongs to the even list, but position 2 takes the odd list',
    )
  })

  test('refuses an unknown word and names its position', () => {
    expectRefusal(
      () => parsePairingCode('42 aardvark adroitness xyzzy aggregate'),
      'word 3 "xyzzy" is not a PGP word list word',
    )
  })
})

describe('pairing code shape', () => {
  test('keeps the nameplate pattern aligned with the maximum', () => {
    expect(NAMEPLATE_PATTERN.test('1')).toBe(true)
    expect(NAMEPLATE_PATTERN.test(String(NAMEPLATE_MAX))).toBe(true)
    expect(NAMEPLATE_PATTERN.test('0')).toBe(false)
    expect(NAMEPLATE_PATTERN.test(String(NAMEPLATE_MAX + 1))).toBe(false)
  })

  test.each(['0', '01', '1000000', 'abc', '1a'])('refuses bad nameplate %s', (nameplate) => {
    expectRefusal(
      () => parsePairingCode(`${nameplate} aardvark adroitness accrue aftermath`),
      `nameplate "${nameplate}"`,
    )
    expect(() => generatePairingCode(nameplate)).toThrow(PairingCodeRefusal)
  })

  test.each(['42 aardvark adroitness accrue', '42 aardvark adroitness accrue aftermath adrift'])(
    'refuses the wrong part count',
    (text) => {
      expectRefusal(() => parsePairingCode(text), 'expected a nameplate and 4 words')
    },
  )

  test('generates four random bytes for a valid nameplate', () => {
    const generated = generatePairingCode('9')
    expect(generated.nameplate).toBe('9')
    expect(generated.secret).toBeInstanceOf(Uint8Array)
    expect(generated.secret).toHaveLength(4)
  })

  test('formats words in lowercase', () => {
    expect(formatPairingCode({ nameplate: '42', secret: Uint8Array.of(9, 10, 17, 26) })).toBe(
      '42-algol-apollo-athens-bradbury',
    )
  })

  test('derives the password only from a copied secret', () => {
    const first = parsePairingCode('7 aardvark adroitness absurd adviser')
    const second = parsePairingCode('99 aardvark adroitness absurd adviser')
    const password = pairingPassword(first)
    expect(password).toEqual(pairingPassword(second))
    expect(password).not.toBe(first.secret)
    password[0] = 255
    expect(first.secret).toEqual(Uint8Array.of(0, 0, 1, 1))
  })
})
