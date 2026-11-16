// concern: review-funnel-admission-evidence
/** Reduces recorded review evidence to the funnel's admission gap and landing snapshot. */

import type { ApplicableReview, ReviewFunnelPlan } from '../review/review-applicability.ts'
import type { TriageReviewRow } from '../review/review-group.ts'
import {
  countsAsLensEvidence,
  hasAdmissibleProvenance,
  newestInadmissibleLensRow,
} from '../review/review-lens-provenance.ts'
import { reviewCountsAsRound } from '../review/review-role.ts'
import { identifySecondOpinionRun } from '../review/review-second-opinion.ts'
import type { ReviewLensOwedReason } from '../review/review-vocabulary.ts'
import { sameStoredChangeOrWitness } from '../review/same-change.ts'

export type TriageReviewGroup = {
  reviews: readonly TriageReviewRow[]
}

export type TriageEvidence = {
  patchId: string
  zeroContextPatchId?: string | null
  pathSet: string
  tier: 0 | 1 | 2 | 3
  applicableReview: ApplicableReview
  reviewPlan?: ReviewFunnelPlan
  branchOwnerSession: string | null
  reviews: readonly TriageReviewRow[]
  branchReviewGroups: readonly TriageReviewGroup[]
  reads: readonly {
    recordId: string
    patchId: string
    zeroContextPatchId?: string | null
    pathSet: string
    recordedAt: string
    sessionId: string | null
    replayMatchesCurrent?: boolean
  }[]
}

type TriageSnapshot = {
  reviewRecordIds: string[]
  patchId: string
  tier: 0 | 1 | 2 | 3
  lensRounds: number
  findingCount: number
  admissionPath: 'exact_review' | 'architect_read'
  readRecordId: string | null
}

/** One applicable lens the change group has no completed result for. */
export type MissingLens = {
  lens: string
  recordedOnBranch: boolean
  reason?: ReviewLensOwedReason
  /** Paths changed since the reviewed tip that select this lens and that it never reviewed. */
  newlyTouchedPaths: string[]
}

export type TriageDecision =
  | { complete: true; snapshot: TriageSnapshot }
  | {
      complete: false
      snapshot: TriageSnapshot
      missingReview: boolean
      unfinishedReviewNumbers: number[]
      undisposedFindings: { reviewNumber: number; ordinal: number }[]
      missingLenses: MissingLens[]
      /**
       * Lenses with a completed result on the branch that this round does not ask to run again,
       * so a refusal can say they need no second run.
       */
      lensesAlreadyComplete: string[]
      missingSecondOpinion: { lens: string; firstRunId: string | null } | null
      architectReadRequired: boolean
      earlierReviewNumber: number | null
      earlierReviewTier: 0 | 1 | 2 | 3 | null
      finalTierRaised: boolean
      noCompleteReviewRound: boolean
    }

/** The one normalization for missing-lens evidence stored or compared by admission. */
function normalizeMissingLensNames(lenses: readonly string[]): string[] {
  return [...new Set(lenses)].sort()
}

/** The lens coverage still required by an incomplete triage decision. */
function missingLensNames(decision: TriageDecision): string[] {
  if (decision.complete) return []
  return normalizeMissingLensNames([
    ...decision.missingLenses.map(({ lens }) => lens),
    ...(decision.missingSecondOpinion
      ? [`second-opinion:${decision.missingSecondOpinion.lens}`]
      : []),
  ])
}

export type CeilingTriageFacts = {
  complete: boolean
  unfinishedReviewNumbers: readonly number[]
  undisposedFindings: readonly { reviewNumber: number; ordinal: number }[]
  missingLenses: readonly string[]
  architectReadRequired: boolean
  hasNonLensGap: boolean
  nonLensGaps: readonly string[]
}

export type CeilingWaivableGaps =
  | { waivable: true; missingLenses: string[] }
  | {
      waivable: false
      blocker:
        | 'complete'
        | 'unfinished-reviews'
        | 'undisposed-findings'
        | 'non-lens-gap'
        | 'no-missing-lenses'
    }

/** The one eligibility rule for what an architect ceiling ruling may waive. */
export function ceilingWaivableGaps(facts: CeilingTriageFacts): CeilingWaivableGaps {
  if (facts.complete) return { waivable: false, blocker: 'complete' }
  if (facts.unfinishedReviewNumbers.length)
    return { waivable: false, blocker: 'unfinished-reviews' }
  if (facts.undisposedFindings.length) return { waivable: false, blocker: 'undisposed-findings' }
  if (facts.hasNonLensGap) return { waivable: false, blocker: 'non-lens-gap' }
  const missingLenses = normalizeMissingLensNames(facts.missingLenses)
  return missingLenses.length || facts.architectReadRequired
    ? { waivable: true, missingLenses }
    : { waivable: false, blocker: 'no-missing-lenses' }
}

/** Map the full triage decision to the ceiling-waiver facts used by both admission edges. */
export function ceilingTriageFacts(decision: TriageDecision): CeilingTriageFacts {
  return decision.complete
    ? {
        complete: true,
        unfinishedReviewNumbers: [],
        undisposedFindings: [],
        missingLenses: [],
        architectReadRequired: false,
        hasNonLensGap: false,
        nonLensGaps: [],
      }
    : (() => {
        const nonLensGaps = [
          ...(decision.finalTierRaised ? ['final tier raised'] : []),
          ...(decision.noCompleteReviewRound ? ['no complete review round'] : []),
        ]
        return {
          complete: false,
          unfinishedReviewNumbers: decision.unfinishedReviewNumbers,
          undisposedFindings: decision.undisposedFindings,
          missingLenses: missingLensNames(decision),
          architectReadRequired: decision.architectReadRequired,
          hasNonLensGap: nonLensGaps.length > 0,
          nonLensGaps,
        }
      })()
}

type CompleteReviewRound = {
  reviews: readonly TriageReviewRow[]
  tier: 0 | 1 | 2 | 3
  completedAt: string
}

type ReviewGaps = {
  missingLenses: {
    lens: string
    recordedOnBranch: boolean
    reason?: ReviewLensOwedReason
  }[]
  undisposedFindings: { reviewNumber: number; ordinal: number }[]
  missingSecondOpinion: { lens: string; firstRunId: string | null } | null
}

/** Composed branch evidence: the gaps, and the one round those reviews compose when complete. */
type BranchCoverageEvidence =
  | { complete: false; coverageGaps: ReviewGaps; round: null }
  | { complete: true; coverageGaps: ReviewGaps; round: CompleteReviewRound }

function recordedLensRounds(reviews: readonly TriageReviewRow[]): number {
  return reviews.reduce(
    (count, review) => count + review.lenses.filter(hasAdmissibleProvenance).length,
    0,
  )
}

export type SecondOpinionDecision =
  | { complete: true }
  | { complete: false; lens: string; firstRunId: string | null }

type SecondOpinionSelection =
  | { complete: true; credited: readonly TriageReviewRow[] }
  | { complete: false; lens: string; firstRunId: string | null }

/**
 * The one rule for a second opinion: two completed, graded runs of the lens whose evidence
 * models differ, as identifySecondOpinionRun decides. A complete selection names the reviews
 * holding the two credited runs.
 */
function selectSecondOpinion(
  reviews: readonly TriageReviewRow[],
  lens: string,
): SecondOpinionSelection {
  const opinions = reviews
    .flatMap((review) => review.lenses.map((opinion) => ({ opinion, review })))
    .sort((left, right) => left.opinion.recordId.localeCompare(right.opinion.recordId))
  const creditedRuns = identifySecondOpinionRun(
    opinions.flatMap(({ opinion, review }) =>
      opinion.runId && countsAsLensEvidence(opinion)
        ? [
            {
              recordId: opinion.recordId,
              runId: opinion.runId,
              lens: opinion.lens,
              model: opinion.model ?? null,
              baseUrl: opinion.baseUrl ?? null,
              graded: opinion.graded,
              completed: review.completedAt !== null,
            },
          ]
        : [],
    ),
    lens,
  )
  const eligible = opinions.filter(
    ({ opinion, review }) =>
      review.completedAt !== null && opinion.lens === lens && countsAsLensEvidence(opinion),
  )
  const first = eligible.find(({ opinion }) => opinion.runId === creditedRuns?.firstRunId)
  const second = eligible.find(({ opinion }) => opinion.runId === creditedRuns?.secondRunId)
  if (!first || !second) {
    return { complete: false, lens, firstRunId: eligible[0]?.opinion.runId ?? null }
  }
  return {
    complete: true,
    credited: [
      ...new Map(
        [first.review, second.review].map((review) => [review.reviewRecordId, review]),
      ).values(),
    ],
  }
}

/** Whether the lens's second opinion is satisfied, and if not, which run asks for one. */
export function decideSecondOpinion(
  reviews: readonly TriageReviewRow[],
  lens: string | undefined,
): SecondOpinionDecision {
  if (!lens) return { complete: true }
  const selection = selectSecondOpinion(reviews, lens)
  return selection.complete ? { complete: true } : selection
}

function undisposedReviewFindings(review: TriageReviewRow) {
  return review.findings
    .filter(({ disposition }) => disposition === null)
    .map(({ ordinal }) => ({ reviewNumber: review.reviewNumber, ordinal }))
}

function coverApplicableLens(
  lens: string,
  currentRequired: ReadonlySet<string>,
  currentCompleted: readonly TriageReviewRow[],
  completed: readonly TriageReviewRow[],
):
  | { kind: 'covered'; review: TriageReviewRow }
  | {
      kind: 'missing'
      recordedOnBranch: boolean
      reason?: ReviewLensOwedReason
    } {
  const hasGradedLens = (review: TriageReviewRow) =>
    review.lenses.some((candidate) => candidate.lens === lens && countsAsLensEvidence(candidate))
  const latest = (currentRequired.has(lens) ? currentCompleted : completed).find((review) =>
    hasGradedLens(review),
  )
  if (latest && latest.tier !== null) return { kind: 'covered', review: latest }
  const coverageReviews = [
    ...new Map(
      [...currentCompleted, ...completed]
        .sort((left, right) => right.reviewNumber - left.reviewNumber)
        .map((review) => [review.reviewRecordId, review]),
    ).values(),
  ]
  const inadmissible = newestInadmissibleLensRow(
    coverageReviews.flatMap((review) => review.lenses),
    lens,
  )
  return {
    kind: 'missing',
    recordedOnBranch: coverageReviews.some((review) =>
      review.lenses.some((candidate) => candidate.lens === lens && candidate.graded),
    ),
    ...(inadmissible ? { reason: inadmissible.reason } : {}),
  }
}

function branchCoverageEvidence(
  branchReviewGroups: readonly TriageReviewGroup[],
  applicableReview: ApplicableReview,
  currentReviews: readonly TriageReviewRow[] = [],
  roundReview: ApplicableReview = applicableReview,
): BranchCoverageEvidence {
  const branchReviews = branchReviewGroups.flatMap(({ reviews }) => reviews)
  const completed = branchReviews
    .filter((review) => review.completedAt !== null)
    .sort((left, right) => right.completedAt!.localeCompare(left.completedAt!))
  const selected = new Map<string, TriageReviewRow>()
  const missingLenses: ReviewGaps['missingLenses'] = []
  const undisposedFindings: { reviewNumber: number; ordinal: number }[] = []
  const currentCompleted = currentReviews
    .filter((review) => review.completedAt !== null)
    .sort((left, right) => right.completedAt!.localeCompare(left.completedAt!))
  const currentRequired = new Set(roundReview.lenses)
  for (const lens of applicableReview.lenses) {
    const coverage = coverApplicableLens(lens, currentRequired, currentCompleted, completed)
    if (coverage.kind === 'missing') {
      missingLenses.push({
        lens,
        recordedOnBranch: coverage.recordedOnBranch,
        ...(coverage.reason ? { reason: coverage.reason } : {}),
      })
      continue
    }
    const untriaged = undisposedReviewFindings(coverage.review)
    if (untriaged.length) {
      undisposedFindings.push(...untriaged)
    }
    selected.set(coverage.review.reviewRecordId, coverage.review)
  }
  const selectedReviews = [...selected.values()]
  const secondOpinionPool =
    roundReview.secondOpinion === applicableReview.secondOpinion ? currentCompleted : completed
  const secondOpinionReviews = applicableReview.secondOpinion
    ? secondOpinionPool.filter((review) =>
        review.lenses.some((lens) => lens.lens === applicableReview.secondOpinion && lens.graded),
      )
    : []
  const opinionSelection = applicableReview.secondOpinion
    ? selectSecondOpinion(
        [
          ...new Map(
            [...selectedReviews, ...secondOpinionReviews].map((review) => [
              review.reviewRecordId,
              review,
            ]),
          ).values(),
        ],
        applicableReview.secondOpinion,
      )
    : ({ complete: true, credited: [] } as const)
  const missingSecondOpinion = opinionSelection.complete
    ? null
    : { lens: opinionSelection.lens, firstRunId: opinionSelection.firstRunId }
  const opinionReviews = opinionSelection.complete ? opinionSelection.credited : []
  undisposedFindings.push(...opinionReviews.flatMap((review) => undisposedReviewFindings(review)))
  const reviews = [
    ...new Map(
      [...selectedReviews, ...opinionReviews].map((review) => [review.reviewRecordId, review]),
    ).values(),
  ]
  const sortedUndisposed = [
    ...new Map(
      undisposedFindings.map((finding) => [`${finding.reviewNumber}/${finding.ordinal}`, finding]),
    ).values(),
  ].sort((a, b) => a.reviewNumber - b.reviewNumber || a.ordinal - b.ordinal)
  const complete =
    reviews.length > 0 &&
    missingLenses.length === 0 &&
    sortedUndisposed.length === 0 &&
    missingSecondOpinion === null
  const coverageGaps: ReviewGaps = {
    missingLenses,
    undisposedFindings: sortedUndisposed,
    missingSecondOpinion,
  }
  if (!complete) return { complete: false, coverageGaps, round: null }
  return {
    complete: true,
    coverageGaps,
    round: {
      reviews,
      tier: Math.max(...reviews.map((review) => review.tier!)) as 0 | 1 | 2 | 3,
      completedAt: reviews
        .map((review) => review.completedAt!)
        .sort((left, right) => right.localeCompare(left))[0]!,
    },
  }
}

function architectReadSnapshot(
  evidence: TriageEvidence,
  round: CompleteReviewRound | null,
  readRecordId: string,
): TriageSnapshot {
  const reviews = round?.reviews ?? []
  return {
    reviewRecordIds: reviews.map((review) => review.reviewRecordId).sort(),
    patchId: evidence.patchId,
    tier: evidence.tier,
    lensRounds: recordedLensRounds(reviews),
    findingCount: reviews.flatMap((review) => review.findings).length,
    admissionPath: 'architect_read',
    readRecordId,
  }
}

/**
 * The read of this current patch that admits the change.
 *
 * Tier `0` has no review round to fall back on, so its read must name a session: the branch
 * owner's, or any identified caller's on a branch no run owns. A read crediting an earlier
 * round at a higher tier matches the branch owner exactly, as it did before tier `0` reads.
 */
export function matchingOwnerRead(evidence: TriageEvidence, recordedAfter?: string) {
  const reader =
    recordedAfter === undefined
      ? (session: string | null) =>
          session !== null &&
          (evidence.branchOwnerSession === null || session === evidence.branchOwnerSession)
      : (session: string | null) => session === evidence.branchOwnerSession
  return evidence.reads.find(
    (read) =>
      reader(read.sessionId) &&
      sameStoredChangeOrWitness(
        read,
        {
          patchId: evidence.patchId,
          zeroContextPatchId: evidence.zeroContextPatchId ?? null,
          pathSet: evidence.pathSet,
        },
      ) &&
      (recordedAfter === undefined || read.recordedAt > recordedAfter),
  )
}

function incompleteArchitectRead(
  evidence: TriageEvidence,
): Exclude<TriageDecision, { complete: true }> {
  return {
    complete: false,
    snapshot: currentChangeEvidence(evidence).snapshot,
    missingReview: false,
    unfinishedReviewNumbers: [],
    undisposedFindings: [],
    missingLenses: [],
    lensesAlreadyComplete: [],
    missingSecondOpinion: null,
    architectReadRequired: true,
    earlierReviewNumber: null,
    earlierReviewTier: null,
    finalTierRaised: false,
    noCompleteReviewRound: false,
  }
}

function decideTierZeroTriage(evidence: TriageEvidence): TriageDecision {
  const current = currentChangeEvidence(evidence)
  const exactRead = matchingOwnerRead(evidence)
  if (!exactRead) return incompleteArchitectRead(evidence)
  if (
    current.currentPatch.unfinishedReviewNumbers.length ||
    current.currentPatch.undisposedFindings.length
  ) {
    return {
      ...incompleteArchitectRead(evidence),
      unfinishedReviewNumbers: current.currentPatch.unfinishedReviewNumbers,
      undisposedFindings: current.currentPatch.undisposedFindings,
      architectReadRequired: false,
    }
  }
  return {
    complete: true,
    snapshot: architectReadSnapshot(evidence, null, exactRead.recordId),
  }
}

function currentChangeEvidence(evidence: TriageEvidence) {
  const reviewRecordIds = [...new Set(evidence.reviews.map((row) => row.reviewRecordId))].sort()
  const findings = evidence.reviews.flatMap((review) =>
    review.findings.map((finding) => ({ ...finding, reviewNumber: review.reviewNumber })),
  )
  const judgedLenses = new Set(
    evidence.reviews
      .filter((review) => review.completedAt !== null)
      .flatMap((review) =>
        review.lenses.flatMap((lens) => (countsAsLensEvidence(lens) ? [lens.lens] : [])),
      ),
  )
  const secondOpinion = decideSecondOpinion(
    evidence.reviews,
    evidence.applicableReview.secondOpinion,
  )
  const currentPatch = {
    unfinishedReviewNumbers: evidence.reviews
      .filter((row) => row.completedAt === null)
      .map((row) => row.reviewNumber)
      .sort((left, right) => left - right),
    undisposedFindings: evidence.reviews
      .flatMap(undisposedReviewFindings)
      .sort((a, b) => a.reviewNumber - b.reviewNumber || a.ordinal - b.ordinal),
  }
  const coverageGaps: ReviewGaps = {
    undisposedFindings: [],
    missingLenses: evidence.applicableReview.lenses
      .filter((lens) => !judgedLenses.has(lens))
      .map((lens) => {
        const candidate = newestInadmissibleLensRow(
          evidence.reviews.flatMap((review) => review.lenses),
          lens,
        )
        return {
          lens,
          recordedOnBranch: candidate !== null,
          ...(candidate ? { reason: candidate.reason } : {}),
        }
      }),
    missingSecondOpinion: secondOpinion.complete
      ? null
      : { lens: secondOpinion.lens, firstRunId: secondOpinion.firstRunId },
  }
  return {
    snapshot: {
      reviewRecordIds,
      patchId: evidence.patchId,
      tier: evidence.tier,
      lensRounds: recordedLensRounds(evidence.reviews),
      findingCount: findings.length,
      admissionPath: 'exact_review' as const,
      readRecordId: null,
    },
    missingReview: evidence.applicableReview.lenses.length > 0 && reviewRecordIds.length === 0,
    currentPatch,
    coverageGaps,
  }
}

function incompleteTriageDecision(input: {
  current: ReturnType<typeof currentChangeEvidence>
  branchCoverage: BranchCoverageEvidence
  exactRead: TriageEvidence['reads'][number] | undefined
  finalTierRaised: boolean
  hasCompletedBranchReview: boolean
  hasFunnelPlan: boolean
  roundLenses: readonly string[]
  newlyTouchedPathsByLens: Readonly<Record<string, string[]>>
  completedLensesOnBranch: readonly string[]
}): Exclude<TriageDecision, { complete: true }> {
  const {
    current,
    branchCoverage,
    exactRead,
    finalTierRaised,
    hasCompletedBranchReview,
    hasFunnelPlan,
  } = input
  const earlierRound = branchCoverage.round
  const emptyGaps: ReviewGaps = {
    missingLenses: [],
    undisposedFindings: [],
    missingSecondOpinion: null,
  }
  const coverageGaps =
    earlierRound && !finalTierRaised
      ? emptyGaps
      : hasCompletedBranchReview
        ? branchCoverage.coverageGaps
        : current.coverageGaps
  const missingReview =
    (earlierRound && !finalTierRaised) || hasCompletedBranchReview ? false : current.missingReview
  const undisposedFindings = [
    ...new Map(
      [...current.currentPatch.undisposedFindings, ...coverageGaps.undisposedFindings].map(
        (finding) => [`${finding.reviewNumber}/${finding.ordinal}`, finding],
      ),
    ).values(),
  ].sort((a, b) => a.reviewNumber - b.reviewNumber || a.ordinal - b.ordinal)
  return {
    complete: false,
    snapshot: current.snapshot,
    missingReview,
    unfinishedReviewNumbers: current.currentPatch.unfinishedReviewNumbers,
    undisposedFindings,
    missingLenses: coverageGaps.missingLenses.map((missing) => ({
      ...missing,
      newlyTouchedPaths: [...(input.newlyTouchedPathsByLens[missing.lens] ?? [])].sort(),
    })),
    lensesAlreadyComplete: input.completedLensesOnBranch.filter(
      (lens) =>
        !input.roundLenses.includes(lens) && lens !== coverageGaps.missingSecondOpinion?.lens,
    ),
    missingSecondOpinion: coverageGaps.missingSecondOpinion,
    architectReadRequired: Boolean(
      earlierRound && (!finalTierRaised || hasFunnelPlan) && !exactRead,
    ),
    earlierReviewNumber: earlierRound?.reviews[0]?.reviewNumber ?? null,
    earlierReviewTier: earlierRound?.tier ?? null,
    finalTierRaised,
    noCompleteReviewRound:
      !branchCoverage.complete &&
      !missingReview &&
      coverageGaps.missingLenses.length === 0 &&
      undisposedFindings.length === 0 &&
      coverageGaps.missingSecondOpinion === null,
  }
}

/** One pure decision over the already-selected rows for a patch/path change group. */
export function decideTriage(evidence: TriageEvidence): TriageDecision {
  if (evidence.tier === 0) return decideTierZeroTriage(evidence)
  const reviewPlan = evidence.reviewPlan ?? {
    round: { lenses: [] },
    admissionRequired: evidence.applicableReview,
  }
  const current = currentChangeEvidence({
    ...evidence,
    applicableReview: reviewPlan.admissionRequired,
  })
  if (
    !current.missingReview &&
    !current.currentPatch.unfinishedReviewNumbers.length &&
    !current.currentPatch.undisposedFindings.length &&
    !current.coverageGaps.missingLenses.length &&
    current.coverageGaps.missingSecondOpinion === null
  ) {
    return { complete: true, snapshot: current.snapshot }
  }
  const branchCoverage = branchCoverageEvidence(
    evidence.branchReviewGroups,
    reviewPlan.admissionRequired,
    evidence.reviews,
    reviewPlan.round,
  )
  const earlierRound = branchCoverage.round
  const hasCompletedBranchReview = evidence.branchReviewGroups.some(({ reviews }) =>
    reviews.some((review) => review.completedAt !== null && reviewCountsAsRound(review.role)),
  )
  const exactRead = earlierRound ? matchingOwnerRead(evidence, earlierRound.completedAt) : undefined
  const finalTierRaised = Boolean(earlierRound && evidence.tier > earlierRound.tier)
  if (
    evidence.reviewPlan !== undefined &&
    (reviewPlan.round.lenses.length > 0 || reviewPlan.round.secondOpinion !== undefined) &&
    branchCoverage.complete &&
    !current.currentPatch.unfinishedReviewNumbers.length &&
    !current.currentPatch.undisposedFindings.length
  ) {
    const { round } = branchCoverage
    return {
      complete: true,
      snapshot: {
        reviewRecordIds: round.reviews.map((review) => review.reviewRecordId).sort(),
        patchId: evidence.patchId,
        tier: evidence.tier,
        lensRounds: recordedLensRounds(round.reviews),
        findingCount: round.reviews.flatMap((review) => review.findings).length,
        admissionPath: 'exact_review',
        readRecordId: null,
      },
    }
  }
  if (
    branchCoverage.complete &&
    (!finalTierRaised || evidence.reviewPlan !== undefined) &&
    exactRead &&
    !current.currentPatch.unfinishedReviewNumbers.length &&
    !current.currentPatch.undisposedFindings.length
  ) {
    return {
      complete: true,
      snapshot: architectReadSnapshot(evidence, branchCoverage.round, exactRead.recordId),
    }
  }
  return incompleteTriageDecision({
    current,
    branchCoverage,
    exactRead,
    finalTierRaised,
    hasCompletedBranchReview,
    hasFunnelPlan: evidence.reviewPlan !== undefined,
    roundLenses: reviewPlan.round.lenses,
    newlyTouchedPathsByLens: reviewPlan.newlyTouchedPathsByLens ?? {},
    completedLensesOnBranch: reviewPlan.completedLensesOnBranch ?? [],
  })
}
