// concern: remedy for cleanup holds on terminal unjudged runs

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { isNotEvidenceFailure } from '../failure/failure.ts'

export type UnjudgedRunRemedy = 'score' | 'void'

/** Choose the verdict command shape that can clear an unjudged-run hold. */
export function decideUnjudgedRunRemedy(failureKind: string | null): UnjudgedRunRemedy {
  return isNotEvidenceFailure(failureKind) ? 'void' : 'score'
}

/** Render the command that clears an unjudged-run hold. */
export function renderUnjudgedRunRemedy(
  remedy: UnjudgedRunRemedy,
  runNumber: number | '<n>',
): string {
  const score = `${PLATFORM_SLUG} score ${runNumber}`
  return remedy === 'void' ? `${score} none --void --note "<why>"` : score
}
