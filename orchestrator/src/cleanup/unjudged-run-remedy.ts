// concern: remedy for cleanup holds on terminal unjudged runs

import { isNotEvidenceFailure } from '../failure/failure.ts'

export type UnjudgedRunRemedy = 'score' | 'void'

/** Choose the verdict command shape that can clear an unjudged-run hold. */
export function decideUnjudgedRunRemedy(failureKind: string | null): UnjudgedRunRemedy {
  return isNotEvidenceFailure(failureKind) ? 'void' : 'score'
}
