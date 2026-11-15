// concern: pull-request-admission-decision
/** Admits one funnel verdict, crediting only an override recorded for its exact identity. */

import type { ReviewFunnelVerdict } from '../review-funnel/decide-review-funnel.ts'
import type { TriageOverrideAttribution } from './override-decision.ts'

export type AdmissionOverride = {
  recordId: string
  project: string
  branch: string
  tip: string
  tree: string
  patchId: string | null
  pathSet: string | null
  attribution: TriageOverrideAttribution
  reason: string
  missingLenses: string[]
}

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
      candidate.tip === change.head &&
      candidate.patchId === change.patchId &&
      candidate.pathSet === change.pathSet,
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
