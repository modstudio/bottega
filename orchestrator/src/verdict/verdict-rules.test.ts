import { describe, expect, test } from 'bun:test'
import {
  effectiveHostedExclusion,
  type JobFacts,
  refuseChildTurnVoid,
  refuseUnvoid,
  refuseVerdict,
  type VerdictFacts,
  VOID_EXCLUSION_REASON,
} from './verdict-rules.ts'

const readOnly: JobFacts = {
  writesRepo: false,
  producesFindings: false,
  hasAnyReviewGrades: false,
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
  test('refuses voiding a child turn and names the conversation root', () => {
    expect(refuseChildTurnVoid(5988, 5931, true)).toBe(
      'refused: turn 5988 is not routing evidence on its own because routing reads roots; ' +
        'voiding one turn is never needed. ' +
        'To void the whole conversation, run orch score 5931 --void.',
    )
  })

  test('allows a root void and a child-turn non-void score', () => {
    expect(refuseChildTurnVoid(5931, 5931, true)).toBeNull()
    expect(refuseChildTurnVoid(5988, 5931, false)).toBeNull()
  })

  test('uses the active hosted exclusion before the run-row fallback', () => {
    expect(effectiveHostedExclusion('active reason', 'run reason')).toBe('active reason')
    expect(effectiveHostedExclusion(null, 'run reason')).toBe('run reason')
    expect(effectiveHostedExclusion(null, null)).toBeNull()
  })

  test('unvoid allows only the orch score --void exclusion reason', () => {
    expect(refuseUnvoid(VOID_EXCLUSION_REASON)).toBeNull()
    for (const reason of [
      'blocked by its tree: database unavailable',
      'shared an output file with other runs',
      'unjudged: owner gone',
    ]) {
      expect(refuseUnvoid(reason)).toContain(`actual exclusion is '${reason}'`)
    }
  })

  test.each([
    [{ delivery: 'other' }, 'delivery must be one of'],
    [{ delivery: 'none', quality: 'right' }, "delivery 'none' takes no quality"],
    [{ quality: null }, "delivery 'full' needs a quality"],
    [{ fidelity: 'other' }, 'fidelity must be one of'],
    [{ job: writing }, 'repository-writing jobs require a fidelity verdict'],
    [{ fidelity: 'faithful' }, 'does not take a fidelity axis'],
    [{ job: { ...readOnly, hasAnyReviewGrades: true } }, 'this job does not produce findings'],
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
