// concern: review-role
/** Owns the recorded role that decides whether review evidence establishes a round. */

export type ReviewRole = 'round' | 'supplementary'

/** Legacy findings runs predate recorded roles and are review rounds. */
function normalizeReviewRole(role: ReviewRole | null): ReviewRole {
  return role ?? 'round'
}

/** Round membership is recorded at dispatch, never inferred from mutable policy. */
export function reviewCountsAsRound(role: ReviewRole): boolean {
  return role === 'round'
}

/** A review is one evidence unit, so every run recorded into it must have one role. */
export function reviewRoleForBatch(roles: readonly (ReviewRole | null)[]): ReviewRole | null {
  const normalized = new Set(roles.map(normalizeReviewRole))
  return normalized.size === 1 ? normalizeReviewRole(roles[0] ?? null) : null
}
