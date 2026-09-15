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
export type ReviewReproduced = (typeof REVIEW_REPRODUCED)[number]
export type ReviewCoverage = (typeof REVIEW_COVERAGE)[number]
export type ReviewLimits = (typeof REVIEW_LIMITS)[number]
export type ReviewOverlap = (typeof REVIEW_OVERLAP)[number]
export type ReviewSeverity = (typeof REVIEW_SEVERITY)[number]

export const MONITOR_SEVERITY = ['informational', 'attention'] as const
export type MonitorSeverity = (typeof MONITOR_SEVERITY)[number]
