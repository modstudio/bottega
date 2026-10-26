import { expect, test } from 'bun:test'
import { sealedValueIsEmpty, stripTrailingNewline } from './sealed-value.ts'

test('a piped value loses one trailing newline and keeps the rest of its text', () => {
  expect(stripTrailingNewline('fixture-token\n')).toBe('fixture-token')
  expect(stripTrailingNewline('fixture-token')).toBe('fixture-token')
  expect(stripTrailingNewline('fixture\nline\n')).toBe('fixture\nline')
  expect(stripTrailingNewline('fixture-token\r\n')).toBe('fixture-token')
})

test('empty and whitespace-only after the strip are empty while spaced text is a value', () => {
  expect(sealedValueIsEmpty('')).toBe(true)
  expect(sealedValueIsEmpty('\n')).toBe(true)
  expect(sealedValueIsEmpty('\r\n')).toBe(true)
  expect(sealedValueIsEmpty('   \n')).toBe(true)
  expect(sealedValueIsEmpty('\t')).toBe(true)
  expect(sealedValueIsEmpty(' fixture-token \n')).toBe(false)
  expect(sealedValueIsEmpty('\nfixture')).toBe(false)
})
