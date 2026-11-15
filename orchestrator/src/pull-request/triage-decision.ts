// concern: pull-request-triage-decision
/** Compatibility exports; review-funnel owns admission evidence decisions. */

export {
  ceilingTriageFacts,
  ceilingWaivableGaps,
  decideSecondOpinion,
  decideTriage,
} from '../review-funnel/review-funnel-admission-evidence.ts'
export type {
  CeilingTriageFacts,
  CeilingWaivableGaps,
  MissingLens,
  TriageDecision,
  TriageEvidence,
  TriageReviewGroup,
} from '../review-funnel/review-funnel-admission-evidence.ts'
