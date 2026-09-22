import { describe, expect, test } from 'bun:test'
import { type JobFacts, refuseVerdict, type VerdictFacts } from './verdict-rules.ts'

const readOnly: JobFacts = {
  writesRepo: false,
  producesFindings: false,
  hasRequiredReviewGrades: false,
}
const valid: VerdictFacts = {
  delivery: 'full',
  quality: 'right',
  fidelity: null,
  job: readOnly,
  failureKind: null,
}
const writing: JobFacts = { ...readOnly, writesRepo: true }
const findings: JobFacts = { ...readOnly, producesFindings: true }

describe('verdict rules', () => {
  test.each([
    [{ delivery: 'other' }, 'delivery must be one of'],
    [{ delivery: 'none', quality: 'right' }, "delivery 'none' takes no quality"],
    [{ quality: null }, "delivery 'full' needs a quality"],
    [{ fidelity: 'other' }, 'fidelity must be one of'],
    [{ job: writing }, 'repository-writing jobs require a fidelity verdict'],
    [{ fidelity: 'faithful' }, 'does not take a fidelity axis'],
    [
      { job: findings },
      'findings-producing jobs require reproduced, coverage, limits, and overlap review grades',
    ],
    [{ failureKind: 'unevidenced' }, 'unevidenced review is not evidence'],
    [{ failureKind: 'sandbox_denied' }, "failure kind 'sandbox_denied' is not evidence"],
  ] as const)('refuses %o', (change, message) => {
    expect(refuseVerdict({ ...valid, ...change })?.message).toContain(message)
  })

  test('accepts a coherent read-only verdict', () => {
    expect(refuseVerdict(valid)).toBeNull()
  })

  test('accepts a writing verdict only with fidelity', () => {
    expect(refuseVerdict({ ...valid, job: writing, fidelity: 'faithful' })).toBeNull()
  })

  test('accepts findings output only when all review grades are present', () => {
    expect(
      refuseVerdict({ ...valid, job: { ...findings, hasRequiredReviewGrades: true } }),
    ).toBeNull()
  })

  // The hosted side knows a run's job by name only. A machine that never
  // published its jobs, or a job since renamed, must not block the verdict the
  // local path already accepted.
  test('judges the axes but stands down on job rules when the job is unreadable', () => {
    expect(refuseVerdict({ ...valid, job: null, fidelity: 'faithful' })).toBeNull()
    expect(refuseVerdict({ ...valid, job: null, quality: null })?.code).toBe('quality')
  })
})
