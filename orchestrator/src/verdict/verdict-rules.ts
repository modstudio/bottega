// concern: verdict-rules
/** Decides whether plain run and score facts form a verdict that may be recorded. */
import { NOT_EVIDENCE } from '../failure/failure.ts'
import { DELIVERY, FIDELITY, QUALITY } from '../score/score.ts'

export const VOID_EXCLUSION_REASON = 'voided with orch score --void'

export function refuseChildTurnVoid(
  requestedId: number,
  resolvedRootId: number,
  voidRequested: boolean,
): string | null {
  if (!voidRequested || requestedId === resolvedRootId) return null
  return (
    `refused: turn ${requestedId} is not routing evidence on its own because routing reads roots; ` +
    'voiding one turn is never needed. ' +
    `To void the whole conversation, run orch score ${resolvedRootId} --void.`
  )
}

export function effectiveHostedExclusion(
  activeExclusionReason: string | null,
  runEvidenceExcluded: string | null,
): string | null {
  return activeExclusionReason ?? runEvidenceExcluded
}

export function refuseUnvoid(evidenceExcluded: string | null): string | null {
  if (evidenceExcluded === VOID_EXCLUSION_REASON) return null
  return `unvoid requires '${VOID_EXCLUSION_REASON}'; actual exclusion is ${evidenceExcluded === null ? 'none' : `'${evidenceExcluded}'`}`
}

/**
 * What the job declares. Null where the scoring side cannot see it: the hosted
 * record knows a run's job by name only, and a machine that has not published
 * its jobs, or a job since renamed, leaves nothing to read. The axes are still
 * judged; the rules that need the declaration stand down rather than refusing a
 * verdict the local path would accept.
 */
export type JobFacts = {
  writesRepo: boolean
  producesFindings: boolean
  hasAnyReviewGrades: boolean
  hasRequiredReviewGrades: boolean
}

export type VerdictFacts = {
  delivery: string
  quality: string | null
  fidelity: string | null
  job: JobFacts | null
  failureKind: string | null
}

export type VerdictRefusal = {
  /** Lets a caller answer a refusal in its own words; the message stands alone. */
  code: 'evidence' | 'delivery' | 'quality' | 'fidelity' | 'fidelity-missing' | 'review-grades'
  message: string
}

function refuseEvidence(input: VerdictFacts): VerdictRefusal | null {
  if (input.failureKind === 'unevidenced') {
    return {
      code: 'evidence',
      message: 'unevidenced review is not evidence; void the run instead of scoring it',
    }
  }
  if (input.failureKind && NOT_EVIDENCE.includes(input.failureKind as never)) {
    return {
      code: 'evidence',
      message: `failure kind '${input.failureKind}' is not evidence; void the run instead of scoring it`,
    }
  }
  return null
}

function refuseAxes(input: VerdictFacts): VerdictRefusal | null {
  if (!DELIVERY.includes(input.delivery as never)) {
    return {
      code: 'delivery',
      message: `delivery must be one of: ${DELIVERY.join(' | ')}; choose one of those delivery values`,
    }
  }
  if (input.delivery === 'none' && input.quality) {
    return {
      code: 'quality',
      message:
        "delivery 'none' takes no quality: there was nothing to judge; remove the quality axis",
    }
  }
  if (input.delivery !== 'none' && (!input.quality || !QUALITY.includes(input.quality as never))) {
    return {
      code: 'quality',
      message: `delivery '${input.delivery}' needs a quality: ${QUALITY.join(' | ')}; provide one of those quality values`,
    }
  }
  if (input.fidelity && !FIDELITY.includes(input.fidelity as never)) {
    return {
      code: 'fidelity',
      message: `fidelity must be one of: ${FIDELITY.join(' | ')}; provide one of those fidelity values`,
    }
  }
  return null
}

function refuseJobRules(input: VerdictFacts, job: JobFacts): VerdictRefusal | null {
  if (job.writesRepo && input.delivery !== 'none' && !input.fidelity) {
    return {
      code: 'fidelity-missing',
      message:
        'repository-writing jobs require a fidelity verdict; provide drifted, partial, or faithful',
    }
  }
  if ((!job.writesRepo || input.delivery === 'none') && input.fidelity) {
    return {
      code: 'fidelity',
      message: 'this verdict does not take a fidelity axis; remove the fidelity value',
    }
  }
  if (!job.producesFindings && job.hasAnyReviewGrades) {
    return {
      code: 'review-grades',
      message: 'this job does not produce findings; remove the review grade fields',
    }
  }
  if (input.delivery === 'none' && job.hasAnyReviewGrades) {
    return {
      code: 'review-grades',
      message: "delivery 'none' takes no review grades; remove the review grade fields",
    }
  }
  if (job.producesFindings && input.delivery !== 'none' && !job.hasRequiredReviewGrades) {
    return {
      code: 'review-grades',
      message:
        'findings-producing jobs require reproduced, coverage, limits, and overlap review grades; record every required review grade before scoring',
    }
  }
  return null
}

export function refuseVerdict(input: VerdictFacts): VerdictRefusal | null {
  return (
    refuseEvidence(input) ??
    refuseAxes(input) ??
    (input.job ? refuseJobRules(input, input.job) : null)
  )
}
