// concern: pull-request-admission-decision
/** Admits review triage or an override recorded for the exact change identity. */

import type { TriageDecision } from './triage-decision.ts'

export type AdmissionChange = {
  project: string
  branch: string
  tip: string
  tree: string
  patchId: string
  pathSet: string
}

export type AdmissionOverride = Omit<AdmissionChange, 'patchId' | 'pathSet'> & {
  id: number
  patchId: string | null
  pathSet: string | null
}

export type AdmissionDecision = {
  complete: boolean
  overrideId: number | null
  triage: TriageDecision
}

/** One pure decision over triage evidence and recorded change-bound overrides. */
export function decideAdmission(
  change: AdmissionChange,
  triage: TriageDecision,
  overrides: readonly AdmissionOverride[],
): AdmissionDecision {
  const override = overrides.find(
    (candidate) =>
      candidate.project === change.project &&
      candidate.branch === change.branch &&
      candidate.tip === change.tip &&
      candidate.tree === change.tree &&
      candidate.patchId === change.patchId &&
      candidate.pathSet === change.pathSet,
  )
  return {
    complete: triage.complete || override !== undefined,
    overrideId: override?.id ?? null,
    triage,
  }
}
