// concern: judgment duplicate link
/** Parses and validates one finding equivalence link over already-loaded review facts. */

export type ParsedDuplicateFinding = {
  ordinal: number
  otherRunId: string
  otherOrdinal: number
}

export function parseDuplicateFinding(value: string): ParsedDuplicateFinding {
  const matched = value.match(/^(\d+)=([^#]+)#(\d+)$/)
  if (!matched) {
    throw new Error(
      `bad --duplicate ${JSON.stringify(value)}; use N=<findings-run>#<finding-number>`,
    )
  }
  return {
    ordinal: Number(matched[1]),
    otherRunId: matched[2]!,
    otherOrdinal: Number(matched[3]),
  }
}

export type DuplicateFindingFacts = {
  currentRunId: string
  currentFindingId: string | null
  currentReviewId: string | null
  currentTip: string | null
  otherRunId: string
  otherFindingsJob: boolean
  otherFindingId: string | null
  otherReviewId: string | null
  otherTip: string | null
  currentDuplicateOfFindingId: string | null
}

/** Returns the actionable refusal, or null when this link may be recorded. */
export function duplicateFindingRefusal(facts: DuplicateFindingFacts): string | null {
  if (facts.currentRunId === facts.otherRunId) {
    return 'the other run must be another findings-job run; name a different run after ='
  }
  if (!facts.otherFindingsJob) {
    return `run ${facts.otherRunId} is not a findings job; name a run that produced review findings`
  }
  if (!facts.currentFindingId) {
    return `finding ordinal does not belong to scored run ${facts.currentRunId}; use a review-level ordinal shown for that run`
  }
  if (!facts.otherFindingId) {
    return `finding ordinal does not belong to run ${facts.otherRunId}; use a review-level ordinal shown for that run`
  }
  const sameReview = facts.currentReviewId !== null && facts.currentReviewId === facts.otherReviewId
  const sameTip = facts.currentTip !== null && facts.currentTip === facts.otherTip
  if (!sameReview && !sameTip) {
    return `run ${facts.otherRunId} reviewed a different review record and tip; name a findings run for the same review or tip`
  }
  if (facts.currentFindingId === facts.otherFindingId) {
    return 'a finding cannot link to itself; name a different finding after ='
  }
  if (facts.currentDuplicateOfFindingId) {
    return 'the scored finding is already linked; remove the repeated --duplicate or link a different scored finding'
  }
  return null
}
