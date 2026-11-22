import { expect, test } from 'bun:test'
import { boardTextSecretRefusal, boardTextsSecretRefusal } from './board-text-secret.ts'

test('the first secret-shaped board field names its rule', () => {
  expect(boardTextsSecretRefusal('board notice', ['safe', 'Bearer ordinary words'])).toBe(
    'board notice contains secret-shaped text (bearer); remove the credential and retry',
  )
})

test('board text refuses the named fixture credential before storage', () => {
  expect(
    boardTextSecretRefusal('board notice', 'quoted ghp_123456789012345678901234567890123456'),
  ).toBe(
    'board notice contains secret-shaped text (provider-prefix); remove the credential and retry',
  )
})

test('hex runs receive the commit abbreviation remedy', () => {
  expect(boardTextSecretRefusal('board reply', 'a'.repeat(40))).toBe(
    'board reply contains secret-shaped text (hex-run); a 32+ hex run looks like a credential; if it is a commit hash, abbreviate it to 12 characters',
  )
})
