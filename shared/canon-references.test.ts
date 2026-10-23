import { describe, expect, test } from 'bun:test'
import { canonReferencePath } from './canon-references.ts'

describe('canonReferencePath', () => {
  test('removes source symbol and line suffixes while preserving an unsuffixed path', () => {
    expect(canonReferencePath('shared/git.ts:borrowedCheckoutFromAlternates')).toBe('shared/git.ts')
    expect(canonReferencePath('shared/git.ts:12-20')).toBe('shared/git.ts')
    expect(canonReferencePath('shared/git.ts')).toBe('shared/git.ts')
  })
})
