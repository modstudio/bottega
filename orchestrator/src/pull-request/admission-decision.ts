// concern: pull-request-admission-decision
/** Admits review triage or an override recorded for the exact change identity. */

import { missingLensNames, type TriageDecision } from './triage-decision.ts'

export type AdmissionChange = {
  project: string
  branch: string
  tip: string
  tree: string
  patchId: string
  pathSet: string
}

export type AdmissionOverride = Omit<AdmissionChange, 'patchId' | 'pathSet'> & {
  recordId: string
  patchId: string | null
  pathSet: string | null
  attribution: 'operator' | 'architect-ceiling'
  missingLenses: string[]
}

export type AdmissionDecision = {
  complete: boolean
  overrideId: string | null
  triage: TriageDecision
}

/** One pure decision over triage evidence and recorded change-bound overrides. */
export function decideAdmission(
  change: AdmissionChange,
  triage: TriageDecision,
  overrides: readonly AdmissionOverride[],
): AdmissionDecision {
  const identityMatches = overrides.filter(
    (candidate) =>
      candidate.project === change.project &&
      candidate.branch === change.branch &&
      candidate.tip === change.tip &&
      candidate.tree === change.tree &&
      candidate.patchId === change.patchId &&
      candidate.pathSet === change.pathSet,
  )
  const override = identityMatches.find((candidate) => {
    if (candidate.attribution === 'operator') return true
    if (triage.complete) return false
    if (triage.unfinishedReviewNumbers.length || triage.undisposedFindings.length) return false
    if (triage.architectReadRequired || triage.finalTierRaised || triage.noCompleteReviewRound)
      return false
    return (
      JSON.stringify(candidate.missingLenses.slice().sort()) ===
      JSON.stringify(missingLensNames(triage))
    )
  })
  return {
    complete: triage.complete || override !== undefined,
    overrideId: override?.recordId ?? null,
    triage,
  }
}
