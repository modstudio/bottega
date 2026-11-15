// concern: pull-request-admission-decision
/** Admits one funnel verdict, crediting an override recorded for its stable patch identity. */

import { sameStoredChange } from '../review/same-change.ts'
import type { ReviewFunnelVerdict } from '../review-funnel/decide-review-funnel.ts'
import type { LandingOverrideRow } from '../review-funnel/gather-funnel-facts.ts'

export type AdmissionOverride = LandingOverrideRow

export type AdmissionDecision = {
  complete: boolean
  overrideId: string | null
  overrideReason: string | null
}

const normalized = (values: readonly string[]) => [...new Set(values)].sort()

/** One pure decision over the shared verdict and recorded change-bound overrides. */
export function decideAdmission(
  verdict: ReviewFunnelVerdict,
  overrides: readonly AdmissionOverride[],
): AdmissionDecision {
  const change = verdict.change
  const identityMatches = overrides.filter(
    (candidate) =>
      candidate.project === change.project &&
      candidate.branch === change.branch &&
      sameStoredChange(
        {
          patchId: candidate.patchId,
          zeroContextPatchId: candidate.zeroContextPatchId ?? null,
          pathSet: candidate.pathSet,
        },
        {
          patchId: change.patchId,
          zeroContextPatchId: change.zeroContextPatchId ?? null,
          pathSet: change.pathSet,
        },
      ),
  )
  const override = identityMatches.find((candidate) => {
    if (candidate.attribution === 'operator') return true
    const overridden = verdict.lenses
      .filter(({ status }) => status === 'overridden')
      .map(({ lens }) => lens)
    return (
      verdict.next.action === 'admit' &&
      JSON.stringify(normalized(candidate.missingLenses)) === JSON.stringify(normalized(overridden))
    )
  })
  return {
    complete: verdict.next.action === 'admit' || override?.attribution === 'operator',
    overrideId: override?.recordId ?? null,
    overrideReason: override?.reason ?? null,
  }
}
