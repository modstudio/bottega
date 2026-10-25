// concern: review-vocabulary
/**
 * Knows review and monitor closed vocabularies. Must not know database state, worktrees, runs, routing, transports, or CLI adapters.
 */
/**
 * Architect-graded review evidence. Keep the closed vocabularies here: the
 * schema, CLI hints and refusals all import these values instead of copying
 * strings that can drift apart.
 */
export const REVIEW_REPRODUCED = ['none', 'some', 'all'] as const
export const REVIEW_COVERAGE = ['empty', 'partial', 'adequate'] as const
export const REVIEW_LIMITS = ['named', 'absent'] as const
export const REVIEW_OVERLAP = ['unique', 'shared', 'none', 'alone'] as const
export const REVIEW_SEVERITY = ['critical', 'high', 'medium', 'low'] as const
const REVIEW_LENS_SELECTION_REASON = [
  'initial',
  'accepted-finding',
  'newly-touched-path',
  'unidentified-tip-funnel',
  'operator-ordered',
] as const
export const REVIEW_GRADE_NAMES = ['reproduced', 'coverage', 'limits', 'overlap'] as const
export const REVIEW_GRADE_VALUES = {
  reproduced: REVIEW_REPRODUCED,
  coverage: REVIEW_COVERAGE,
  limits: REVIEW_LIMITS,
  overlap: REVIEW_OVERLAP,
} as const
export const DISPOSITIONS = ['accepted', 'modified', 'rejected', 'skipped'] as const
export type Disposition = (typeof DISPOSITIONS)[number]

/** The `--finding` value after `N=`, shared by score help and its missing-finding refusal. */
export const FINDING_VALUE = `<${DISPOSITIONS.join('|')}>:<detail>`
export const FINDING_DETAIL_RULE = `accepted/modified/skipped detail is ${REVIEW_SEVERITY.join('|')}; rejected detail is a lowercase stable category ID of 1-64 characters`
export type ReviewReproduced = (typeof REVIEW_REPRODUCED)[number]
export type ReviewCoverage = (typeof REVIEW_COVERAGE)[number]
export type ReviewLimits = (typeof REVIEW_LIMITS)[number]
export type ReviewOverlap = (typeof REVIEW_OVERLAP)[number]
export type ReviewSeverity = (typeof REVIEW_SEVERITY)[number]
export type ReviewLensSelectionReason = (typeof REVIEW_LENS_SELECTION_REASON)[number]

const MONITOR_SEVERITY = ['informational', 'attention'] as const
export type MonitorSeverity = (typeof MONITOR_SEVERITY)[number]
