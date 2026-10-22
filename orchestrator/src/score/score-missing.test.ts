import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { FINDING_DETAIL_RULE, FINDING_VALUE } from '../review/review-triage.ts'
import {
  type GivenScoreFlags,
  missingScoreRefusal,
  missingScoreRequirements,
  workingScoreForm,
} from './score-missing.ts'

const emptyGrades = {
  reproduced: undefined,
  coverage: undefined,
  limits: undefined,
  overlap: undefined,
} satisfies GivenScoreFlags['grades']

test('a review-lens score with only delivery names every remaining required flag once', () => {
  const job = { writesRepo: false, producesFindings: true }
  const given: GivenScoreFlags = {
    delivery: 'full',
    quality: undefined,
    fidelity: undefined,
    grades: emptyGrades,
    requiredFindings: [1, 2],
  }
  const missing = missingScoreRequirements(job, given)
  expect(missing).toEqual([
    'quality <wrong|mixed|right>',
    '--reproduced none | some | all',
    '--coverage empty | partial | adequate',
    '--limits named | absent',
    '--overlap unique | shared | none | alone',
    `--finding 1=${FINDING_VALUE} (${FINDING_DETAIL_RULE})`,
    `--finding 2=${FINDING_VALUE} (${FINDING_DETAIL_RULE})`,
  ])
  const form = workingScoreForm('run-lens', job, given)
  expect(form).toBe(
    `${PLATFORM_SLUG} score run-lens full right --reproduced all --coverage adequate --limits named --overlap unique --finding 1=accepted:high --finding 2=accepted:high`,
  )
  const refusal = missingScoreRefusal('run-lens', missing, form)
  expect(refusal).toContain('quality')
  expect(refusal).toContain('--reproduced')
  expect(refusal).toContain('--coverage')
  expect(refusal).toContain('--limits')
  expect(refusal).toContain('--overlap')
  expect(refusal).toContain('--finding 1=')
  expect(refusal).toContain('--finding 2=')
  expect(refusal).toContain(form)
})

test('an implement score with only full names quality and fidelity together', () => {
  const job = { writesRepo: true, producesFindings: false }
  const given: GivenScoreFlags = {
    delivery: 'full',
    quality: undefined,
    fidelity: undefined,
    grades: emptyGrades,
    requiredFindings: [],
  }
  const missing = missingScoreRequirements(job, given)
  expect(missing).toEqual(['quality <wrong|mixed|right>', 'fidelity <drifted|partial|faithful>'])
  const form = workingScoreForm('run-impl', job, given)
  expect(form).toBe(`${PLATFORM_SLUG} score run-impl full right faithful`)
  const refusal = missingScoreRefusal('run-impl', missing, form)
  expect(refusal).toContain('quality')
  expect(refusal).toContain('fidelity')
  expect(refusal).toContain(form)
})
