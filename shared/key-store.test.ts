import { describe, expect, test } from 'bun:test'
import { decideKeyStore } from './key-store.ts'

describe('key store decision', () => {
  test('selects only the explicit file opt-in', () => {
    expect(decideKeyStore('file')).toBe('file')
    expect(decideKeyStore(undefined)).toBe('keychain')
    expect(() => decideKeyStore('unknown')).toThrow("BOTTEGA_KEYSTORE must be 'file' when set")
  })
})
