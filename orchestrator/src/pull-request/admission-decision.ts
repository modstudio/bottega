// concern: pull-request-admission-decision
/** Admits one funnel verdict, crediting only an override recorded for its exact identity. */

import type { ReviewFunnelVerdict } from '../review-funnel/decide-review-funnel.ts'
import type { TriageOverrideAttribution } from './override-decision.ts'
import type { TriageDecision } from './triage-decision.ts'

export type AdmissionOverride = {
  recordId: string
  project: string
  branch: string
  tip: string
  tree: string
  patchId: string | null
  pathSet: string | null
  attribution: TriageOverrideAttribution
  missingLenses: string[]
}

export type AdmissionDecision = {
  complete: boolean
  overrideId: string | null
  /** Snapshot evidence carried by admission adapters, never consulted by decideAdmission. */
  triage?: TriageDecision
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
    complete: verdict.next.action === 'admit',
    overrideId: override?.recordId ?? null,
  }
}
