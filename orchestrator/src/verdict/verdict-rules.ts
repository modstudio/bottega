// concern: verdict-rules
/** Decides whether plain run and score facts form a verdict that may be recorded. */
import { NOT_EVIDENCE } from '../failure/failure.ts'
import { DELIVERY, FIDELITY, QUALITY } from '../score/score.ts'

export type VerdictFacts = {
  delivery: string
  quality: string | null
  fidelity: string | null
  writesRepo: boolean
  producesFindings: boolean
  hasRequiredReviewGrades: boolean
  failureKind: string | null
  probe: boolean
}

export function refuseVerdict(input: VerdictFacts): string | null {
  if (input.probe) return 'probe runs are diagnostics, not routing evidence; do not score this run'
  if (input.failureKind === 'unevidenced') {
    return 'unevidenced review is not evidence; void the run instead of scoring it'
  }
  if (input.failureKind && NOT_EVIDENCE.includes(input.failureKind as never)) {
    return `failure kind '${input.failureKind}' is not evidence; void the run instead of scoring it`
  }
  if (!DELIVERY.includes(input.delivery as never)) {
    return `delivery must be one of: ${DELIVERY.join(' | ')}; choose one of those delivery values`
  }
  if (input.delivery === 'none' && input.quality) {
    return "delivery 'none' takes no quality: there was nothing to judge; remove the quality axis"
  }
  if (input.delivery !== 'none' && (!input.quality || !QUALITY.includes(input.quality as never))) {
    return `delivery '${input.delivery}' needs a quality: ${QUALITY.join(' | ')}; provide one of those quality values`
  }
  if (input.fidelity && !FIDELITY.includes(input.fidelity as never)) {
    return `fidelity must be one of: ${FIDELITY.join(' | ')}; provide one of those fidelity values`
  }
  if (input.writesRepo && input.delivery !== 'none' && !input.fidelity) {
    return 'repository-writing jobs require a fidelity verdict; provide drifted, partial, or faithful'
  }
  if ((!input.writesRepo || input.delivery === 'none') && input.fidelity) {
    return 'this verdict does not take a fidelity axis; remove the fidelity value'
  }
  if (input.producesFindings && input.delivery !== 'none' && !input.hasRequiredReviewGrades) {
    return 'findings-producing jobs require reproduced, coverage, limits, and overlap review grades; record every required review grade before scoring'
  }
  return null
}
