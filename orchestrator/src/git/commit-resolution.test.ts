import { describe, expect, test } from 'bun:test'
import { decideCommitResolution } from './commit-resolution.ts'

describe('recorded-evidence commit resolution', () => {
  const checkout = '/projects/app'
  const commit = '0123456789abcdef0123456789abcdef01234567'

  test('accepts a resolved full hash', () => {
    expect(decideCommitResolution(commit, checkout, { resolved: commit })).toEqual({ commit })
  })

  test('returns the full hash resolved from an abbreviation', () => {
    expect(decideCommitResolution('0123456', checkout, { resolved: `${commit}\n` })).toEqual({
      commit,
    })
  })

  test('refuses an unresolvable argument with the checkout and remedy', () => {
    expect(decideCommitResolution('missing', checkout, {})).toEqual({
      refusal:
        'missing does not resolve to a commit in /projects/app; run `git fetch` in that checkout, or pass the full hash',
    })
  })

  test('refuses an ambiguous abbreviation with every candidate commit', () => {
    const candidates = ['a'.repeat(40), 'b'.repeat(40)]
    expect(decideCommitResolution('abcd', checkout, { candidates })).toEqual({
      refusal: `abcd is ambiguous in /projects/app; candidate commits: ${candidates.join(', ')}`,
    })
  })
})
