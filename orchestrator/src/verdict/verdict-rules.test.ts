import { describe, expect, test } from 'bun:test'
import { refuseVerdict, type VerdictFacts } from './verdict-rules.ts'

const valid: VerdictFacts = {
  delivery: 'full',
  quality: 'right',
  fidelity: null,
  writesRepo: false,
  producesFindings: false,
  hasRequiredReviewGrades: false,
  failureKind: null,
  probe: false,
}

describe('verdict rules', () => {
  test.each([
    [{ delivery: 'other' }, 'delivery must be one of'],
    [{ delivery: 'none', quality: 'right' }, "delivery 'none' takes no quality"],
    [{ quality: null }, "delivery 'full' needs a quality"],
    [{ fidelity: 'other' }, 'fidelity must be one of'],
    [{ writesRepo: true }, 'repository-writing jobs require a fidelity verdict'],
    [{ fidelity: 'faithful' }, 'does not take a fidelity axis'],
    [
      { producesFindings: true },
      'findings-producing jobs require reproduced, coverage, limits, and overlap review grades',
    ],
    [{ failureKind: 'unevidenced' }, 'unevidenced review is not evidence'],
    [{ failureKind: 'sandbox_denied' }, "failure kind 'sandbox_denied' is not evidence"],
    [{ probe: true }, 'probe runs are diagnostics'],
  ] as const)('refuses %o', (change, message) => {
    expect(refuseVerdict({ ...valid, ...change })).toContain(message)
  })

  test('accepts a coherent read-only verdict', () => {
    expect(refuseVerdict(valid)).toBeNull()
  })

  test('accepts a writing verdict only with fidelity', () => {
    expect(refuseVerdict({ ...valid, writesRepo: true, fidelity: 'faithful' })).toBeNull()
  })

  test('accepts findings output only when all review grades are present', () => {
    expect(
      refuseVerdict({ ...valid, producesFindings: true, hasRequiredReviewGrades: true }),
    ).toBeNull()
  })
})
