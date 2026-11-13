// concern: review-funnel-decision
/** Dependency-free vocabulary for one lens in a review-funnel verdict. */

const REVIEW_FUNNEL_LENS_STATUSES = [
  'owed',
  'running',
  'untriaged',
  'satisfied',
  'credited-by-read',
  'not-applicable',
  'waived-at-ceiling',
  'overridden',
] as const

export type ReviewFunnelLensStatus = (typeof REVIEW_FUNNEL_LENS_STATUSES)[number]
