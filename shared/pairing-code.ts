// concern: pairing codes

import { PGP_EVEN_WORDS, PGP_ODD_WORDS } from './pgp-word-list.ts'

const NAMEPLATE_PATTERN = /^[1-9][0-9]{0,5}$/
const SECRET_SIZE = 4
const evenWordIndexes = wordIndexes(PGP_EVEN_WORDS)
const oddWordIndexes = wordIndexes(PGP_ODD_WORDS)

export interface PairingCode {
  nameplate: string
  secret: Uint8Array
}

export class PairingCodeRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PairingCodeRefusal'
  }
}

function wordIndexes(words: readonly string[]): ReadonlyMap<string, number> {
  return new Map(words.map((word, index) => [word.toLowerCase(), index]))
}

function validateNameplate(nameplate: string): void {
  if (!NAMEPLATE_PATTERN.test(nameplate)) {
    throw new PairingCodeRefusal(
      `nameplate "${nameplate}" must be 1 to 6 digits, start with 1 to 9, and contain only digits`,
    )
  }
}

function validateSecret(secret: Uint8Array): void {
  if (secret.length !== SECRET_SIZE) {
    throw new Error(`pairing code secret must be exactly ${SECRET_SIZE} bytes`)
  }
}

export function generatePairingCode(nameplate: string): PairingCode {
  validateNameplate(nameplate)
  return { nameplate, secret: crypto.getRandomValues(new Uint8Array(SECRET_SIZE)) }
}

export function formatPairingCode(code: PairingCode): string {
  validateNameplate(code.nameplate)
  validateSecret(code.secret)
  const words = Array.from(code.secret, (byte, index) => {
    const list = index % 2 === 0 ? PGP_EVEN_WORDS : PGP_ODD_WORDS
    return list[byte]!.toLowerCase()
  })
  return [code.nameplate, ...words].join('-')
}

function parseWord(word: string, index: number): number {
  const position = index + 1
  const normalized = word.toLowerCase()
  const takesEvenList = index % 2 === 0
  const expectedIndexes = takesEvenList ? evenWordIndexes : oddWordIndexes
  const otherIndexes = takesEvenList ? oddWordIndexes : evenWordIndexes
  const expectedIndex = expectedIndexes.get(normalized)
  if (expectedIndex !== undefined) {
    return expectedIndex
  }
  if (otherIndexes.has(normalized)) {
    const otherName = takesEvenList ? 'odd' : 'even'
    const expectedName = takesEvenList ? 'even' : 'odd'
    throw new PairingCodeRefusal(
      `word ${position} "${word}" belongs to the ${otherName} list, but position ${position} takes the ${expectedName} list`,
    )
  }
  throw new PairingCodeRefusal(`word ${position} "${word}" is not a PGP word list word`)
}

export function parsePairingCode(text: string): PairingCode {
  const parts = text.trim().split(/[\s-]+/)
  if (parts.length !== SECRET_SIZE + 1) {
    throw new PairingCodeRefusal(
      `pairing code has ${parts.length} parts; expected a nameplate and 4 words`,
    )
  }
  const [nameplate, ...words] = parts as [string, string, string, string, string]
  validateNameplate(nameplate)
  return { nameplate, secret: Uint8Array.from(words.map(parseWord)) }
}

export function pairingPassword(code: PairingCode): Uint8Array {
  validateSecret(code.secret)
  return code.secret.slice()
}
