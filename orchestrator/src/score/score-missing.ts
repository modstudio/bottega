// concern: score-missing
/**
 * Knows which score axes and flags a job still needs from the given words and
 * flags. Must not know database state, worktrees, runs, routing, or transports.
 */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { FINDING_DETAIL_RULE, FINDING_VALUE } from '../review/review-triage.ts'
import {
  REVIEW_COVERAGE,
  REVIEW_LIMITS,
  REVIEW_OVERLAP,
  REVIEW_REPRODUCED,
} from '../review/review-vocabulary.ts'
import { DELIVERY, FIDELITY, QUALITY } from './score.ts'

export const REVIEW_GRADE_NAMES = ['reproduced', 'coverage', 'limits', 'overlap'] as const
export const REVIEW_GRADE_VALUES = {
  reproduced: REVIEW_REPRODUCED,
  coverage: REVIEW_COVERAGE,
  limits: REVIEW_LIMITS,
  overlap: REVIEW_OVERLAP,
} as const

const EXAMPLE = {
  delivery: 'full',
  quality: 'right',
  fidelity: 'faithful',
  reproduced: 'all',
  coverage: 'adequate',
  limits: 'named',
  overlap: 'unique',
  finding: 'accepted:high',
} as const

export type ScoreRequirementJob = {
  writesRepo: boolean
  producesFindings: boolean
}

export type GivenScoreFlags = {
  delivery: string | undefined
  quality: string | undefined
  fidelity: string | undefined
  grades: Record<(typeof REVIEW_GRADE_NAMES)[number], string | undefined>
  requiredFindings: readonly number[]
}

function axisToken(name: string, levels: readonly string[]): string {
  return `${name} <${levels.join('|')}>`
}

function missingReviewGradeFlag(name: (typeof REVIEW_GRADE_NAMES)[number]): string {
  return `--${name} ${REVIEW_GRADE_VALUES[name].join(' | ')}`
}

function missingReviewFindingFlag(ordinal: number): string {
  return `--finding ${ordinal}=${FINDING_VALUE} (${FINDING_DETAIL_RULE})`
}

function needsPostDelivery(delivery: string | undefined): boolean {
  return delivery !== 'none'
}

/** The job's required axes and flags that the given words and flags have not filled. */
export function missingScoreRequirements(
  job: ScoreRequirementJob,
  given: GivenScoreFlags,
): string[] {
  const missing: string[] = []
  if (!given.delivery) missing.push(axisToken('delivery', DELIVERY))
  if (needsPostDelivery(given.delivery) && !given.quality) {
    missing.push(axisToken('quality', QUALITY))
  }
  if (needsPostDelivery(given.delivery) && job.writesRepo && !given.fidelity) {
    missing.push(axisToken('fidelity', FIDELITY))
  }
  if (!needsPostDelivery(given.delivery) || !job.producesFindings) return missing
  for (const name of REVIEW_GRADE_NAMES) {
    if (!given.grades[name]) missing.push(missingReviewGradeFlag(name))
  }
  for (const ordinal of given.requiredFindings) missing.push(missingReviewFindingFlag(ordinal))
  return missing
}

/** One complete command that fills every required axis and flag from what was given. */
export function workingScoreForm(
  runId: string,
  job: ScoreRequirementJob,
  given: GivenScoreFlags,
): string {
  const delivery = given.delivery ?? EXAMPLE.delivery
  const parts = [`${PLATFORM_SLUG} score ${runId}`, delivery]
  if (delivery === 'none') return parts.join(' ')
  parts.push(given.quality ?? EXAMPLE.quality)
  if (job.writesRepo) parts.push(given.fidelity ?? EXAMPLE.fidelity)
  if (!job.producesFindings) return parts.join(' ')
  for (const name of REVIEW_GRADE_NAMES) {
    parts.push(`--${name} ${given.grades[name] ?? EXAMPLE[name]}`)
  }
  for (const ordinal of given.requiredFindings) {
    parts.push(`--finding ${ordinal}=${EXAMPLE.finding}`)
  }
  return parts.join(' ')
}

export function missingScoreRefusal(
  runId: string,
  missing: readonly string[],
  workingForm: string,
): string {
  return (
    `${PLATFORM_SLUG} score ${runId} is missing:\n` +
    `${missing.map((item) => `  ${item}`).join('\n')}\n` +
    `  ${workingForm}`
  )
}
