import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { scoredVoidFidelity } from '../evidence-exclusion.ts'
import { refuseJudgeVerdictAxes } from '../judgment.ts'
import { refuseRecalibrationVerdict } from '../score/recalibration.ts'
import {
  axisOnlyJobFacts,
  type JobFacts,
  refuseChildTurnVoid,
  refuseHostedUnvoid,
  refuseUnusableThirdVerdictWord,
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
  test('refuses only an unusable third verdict word on a two-axis job', () => {
    const refusal = refuseUnusableThirdVerdictWord('diagnose', false, 'xyz')
    expect(refusal).toEqual({
      code: 'fidelity',
      message:
        'diagnose is judged on two axes only: delivery (none | partial | full) and ' +
        "quality (wrong | mixed | right); 'xyz' is not a verdict word for diagnose; remove it",
    })
    expect(refuseUnusableThirdVerdictWord('diagnose', false, 'faithful')).toBeNull()
    expect(refuseUnusableThirdVerdictWord('implement', true, 'xyz')).toBeNull()
    expect(refuseUnusableThirdVerdictWord('diagnose', false, undefined)).toBeNull()
  })

  test('refuses voiding a child turn and names the conversation root', () => {
    expect(refuseChildTurnVoid('5988', '5931', true)).toBe(
      'refused: turn 5988 is not routing evidence on its own because routing reads roots; ' +
        'voiding one turn is never needed. ' +
        `To void the whole conversation, run ${PLATFORM_SLUG} score 5931 --void.`,
    )
  })

  test('allows a root void and a child-turn non-void score', () => {
    expect(refuseChildTurnVoid('5931', '5931', true)).toBeNull()
    expect(refuseChildTurnVoid('5988', '5931', false)).toBeNull()
  })

  test('unvoid accepts the frozen stored exclusion reason and names public commands in refusals', () => {
    expect(VOID_EXCLUSION_REASON).toBe(['voided with', 'orch', 'score --void'].join(' '))
    expect(refuseUnvoid(VOID_EXCLUSION_REASON)).toBeNull()
    for (const reason of [
      'blocked by its tree: database unavailable',
      'shared an output file with other runs',
      'unjudged: owner gone',
    ]) {
      const refusal = refuseUnvoid(reason)
      expect(refusal).toContain(`${PLATFORM_SLUG} score --void`)
      expect(refusal).toContain(`${PLATFORM_SLUG} score --unvoid`)
      expect(refusal).toContain(`actual exclusion is '${reason}'`)
    }
  })

  test.each([
    [null, null],
    [VOID_EXCLUSION_REASON, null],
    [null, VOID_EXCLUSION_REASON],
    [VOID_EXCLUSION_REASON, VOID_EXCLUSION_REASON],
  ] as const)(
    'hosted unvoid allows active exclusion %p and run exclusion %p',
    (activeExclusionReason, runEvidenceExcluded) => {
      expect(refuseHostedUnvoid(activeExclusionReason, runEvidenceExcluded)).toBeNull()
    },
  )

  test.each([
    ['blocked by its tree: database unavailable', null],
    [null, 'blocked by its tree: database unavailable'],
  ] as const)(
    'hosted unvoid keeps the single-exclusion refusal for active exclusion %p and run exclusion %p',
    (activeExclusionReason, runEvidenceExcluded) => {
      expect(refuseHostedUnvoid(activeExclusionReason, runEvidenceExcluded)).toBe(
        `only ${PLATFORM_SLUG} score --unvoid can clear an exclusion created by ${PLATFORM_SLUG} score --void; actual exclusion is 'blocked by its tree: database unavailable'`,
      )
    },
  )

  test.each([
    ['blocked by its tree: database unavailable', VOID_EXCLUSION_REASON],
    [VOID_EXCLUSION_REASON, 'unjudged: owner gone'],
    ['blocked by its tree: database unavailable', 'unjudged: owner gone'],
  ] as const)(
    'hosted unvoid refuses active exclusion %p with run exclusion %p',
    (activeExclusionReason, runEvidenceExcluded) => {
      const refusal = refuseHostedUnvoid(activeExclusionReason, runEvidenceExcluded)
      expect(refusal).toContain(`active exclusion is '${activeExclusionReason}'`)
      expect(refusal).toContain(`run evidence_excluded is '${runEvidenceExcluded}'`)
      expect(refusal).toContain('the other exclusion must be cleared by the command that owns it')
    },
  )

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

  test.each([
    { delivery: 'other', quality: 'right', fidelity: undefined, writesRepo: false },
    { delivery: 'none', quality: 'right', fidelity: undefined, writesRepo: false },
    { delivery: 'full', quality: 'other', fidelity: undefined, writesRepo: false },
    { delivery: 'full', quality: 'right', fidelity: 'other', writesRepo: true },
    { delivery: 'full', quality: 'right', fidelity: undefined, writesRepo: true },
  ] as const)(
    'keeps caller refusal %o identical',
    ({ delivery, quality, fidelity, writesRepo }) => {
      const facts: VerdictFacts = {
        delivery,
        quality,
        fidelity: writesRepo && (delivery as string) !== 'none' ? (fidelity ?? null) : null,
        job: axisOnlyJobFacts(writesRepo),
        failureKind: null,
      }
      const canonical = refuseVerdict(facts)?.message
      expect(canonical).toBeDefined()

      let voidMessage: string | undefined
      try {
        scoredVoidFidelity(
          writesRepo ? 'implement' : 'file-question',
          delivery as never,
          quality as never,
          fidelity as never,
        )
      } catch (error) {
        voidMessage = error instanceof Error ? error.message : String(error)
      }

      expect(voidMessage).toBe(canonical)
      const judgeRefusal = refuseJudgeVerdictAxes(
        { log() {}, error() {}, pairHint: () => '' },
        writesRepo ? 'implement' : 'file-question',
        null,
        [delivery, quality, fidelity],
        writesRepo,
      )
      if (writesRepo && delivery === 'full' && fidelity === undefined) {
        // Judge fills 'faithful' and checks for a missing score later.
        expect(judgeRefusal).toBeNull()
      } else {
        expect(judgeRefusal?.message).toBe(canonical)
      }
      expect(
        refuseRecalibrationVerdict(
          delivery,
          quality,
          fidelity,
          writesRepo,
          writesRepo && (delivery as string) !== 'none',
        )?.message,
      ).toBe(canonical)
    },
  )

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
