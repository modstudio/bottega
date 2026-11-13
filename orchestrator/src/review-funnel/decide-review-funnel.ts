// concern: review-funnel-decision
/** Pure decision for everything one measured change owes the review funnel. */

import type { ReviewSettings } from '../project/project-injection.ts'
import { applicableReview } from '../review/review-applicability.ts'
import type { TriageReviewRow } from '../review/review-group.ts'
import {
  type LensProvenanceSubjectFacts,
  lensProvenanceSubject,
} from '../review/review-lens-provenance.ts'
import {
  type PostFixReviewFacts,
  type RebaseFileComparison,
  postFixReviewDecision,
  rebaseCarryDecision,
} from '../review/review-post-fix.ts'
import { reviewRoundBudgetDecision } from '../review/review-round-budget.ts'
import {
  applicableRoundLensPlan,
  reviewPlanForBudget,
  roundLensFacts,
} from '../review/review-round-lens-plan.ts'
import { classifyReviewTier, type ReviewTierFile } from '../review/review-tier-classifier.ts'
import { ceilingWaivableGaps } from '../pull-request/triage-decision.ts'
import type { ReviewFunnelPolicy } from './review-funnel-policy.ts'

export type ReviewFunnelChangeIdentity = {
  project: string
  taskKey: string | null
  branch: string
  head: string
  patchId: string
  paths: string[]
}

export type ReviewFunnelLensState = {
  lens: string
  runId: string
  state: 'running' | 'untriaged'
}

export type ReviewFunnelRoundFact = {
  reviewRecordId: string
  identity: string | null
  provenance: LensProvenanceSubjectFacts
  landed: boolean
}

export type ReviewFunnelFacts = {
  change: ReviewFunnelChangeIdentity
  files: ReviewTierFile[]
  review: ReviewSettings | undefined
  branchReviews: TriageReviewRow[]
  postFix: PostFixReviewFacts
  rounds: ReviewFunnelRoundFact[]
  currentRoundIdentity: string | null
  lensStates: ReviewFunnelLensState[]
  exactRead: boolean
  readCreditsRound: boolean
  ceilingRuling: boolean
  overriddenLenses: string[]
  triageComplete: boolean
  admissionGap: {
    unfinishedReviewNumbers: number[]
    undisposedFindings: { reviewNumber: number; ordinal: number }[]
    missingLenses: string[]
    architectReadRequired: boolean
    nonLensGaps: string[]
  }
  rebase?: {
    files: RebaseFileComparison[]
    pathsByLens: Readonly<Record<string, readonly string[]>>
  }
}

export type ReviewFunnelLensStatus =
  | 'owed'
  | 'running'
  | 'untriaged'
  | 'satisfied'
  | 'credited-by-read'
  | 'not-applicable'
  | 'waived-at-ceiling'
  | 'overridden'

export type ReviewFunnelNextAction =
  | 'dispatch'
  | 'wait'
  | 'triage'
  | 'record-read'
  | 'ask-ceiling-ruling'
  | 'admit'

export type ReviewFunnelVerdict = {
  policyVersion: string
  mode: 'evaluate' | 'enforce'
  change: ReviewFunnelChangeIdentity
  tier: {
    tier: 0 | 1 | 2 | 3
    risk: 0 | 1 | 2 | 3
    size: 0 | 1 | 2 | 3
    firm: boolean
    lowered: boolean
    reasons: string[]
  }
  budget: { roundsUsed: number; ceiling: number; atCeiling: boolean }
  lenses: { lens: string; status: ReviewFunnelLensStatus; reason: string }[]
  next: { action: ReviewFunnelNextAction; lenses?: string[] }
  remedy: string
}

function mode(policy: ReviewFunnelPolicy): 'evaluate' | 'enforce' {
  return Object.values(policy.modes).every((value) => value === 'enforce')
    ? 'enforce'
    : 'evaluate'
}

const dispatchRemedy = (change: ReviewFunnelChangeIdentity, lenses: readonly string[]): string => {
  const lens = lenses[0]!
  return `bottega run start review-lens --review ${change.branch} --key ${change.taskKey ?? '<task-key>'} --lens ${lens} "Review ${change.branch} with ${lens}."`
}

function reasonForLens(input: {
  lens: string
  plannedReason: string | undefined
  postFix: ReturnType<typeof postFixReviewDecision>
  provenanceMismatch: boolean
}): string {
  if (input.provenanceMismatch) return 'provenance-mismatch'
  if (
    input.postFix.kind === 're-lens' &&
    Object.hasOwn(input.postFix.reOwedPathsByLens ?? {}, input.lens)
  )
    return 'rebase-changed-file'
  return input.plannedReason ?? 'initial'
}

/** Decide one verdict from plain gathered facts and one validated policy. */
export function decideReviewFunnel(
  facts: ReviewFunnelFacts,
  policy: ReviewFunnelPolicy,
  policyVersion = 'builtin',
): ReviewFunnelVerdict {
  const tier = classifyReviewTier({ files: facts.files, risk: facts.review?.risk })
  const rebase = facts.rebase ? rebaseCarryDecision(facts.rebase) : null
  const postFixFacts =
    rebase && facts.postFix.completed
      ? { ...facts.postFix, fixFiles: rebase.fixFiles, reOwedPathsByLens: rebase.reOwedPathsByLens }
      : facts.postFix
  const postFix = postFixReviewDecision({ facts: postFixFacts, tier: tier.tier, review: facts.review })
  const relevant = applicableReview(
    tier.tier,
    facts.files.map(({ path }) => path),
    facts.review,
  )
  const roundFacts = roundLensFacts(facts.branchReviews, {
    patchId: facts.change.patchId,
    pathSet: JSON.stringify([...facts.change.paths].sort()),
  })
  const fixPaths =
    postFix.kind === 're-lens' || postFix.kind === 'comparison-failed' ? postFix.fixPaths : []
  const fixPathsByLens = Object.fromEntries(
    relevant.lenses.map((lens) => [lens, fixPaths]),
  )
  const unbudgetedPlan = applicableRoundLensPlan({
    relevant,
    facts: roundFacts,
    postFix,
    fixPathsByLens,
  })
  const eligibleRounds = facts.rounds.filter(
    (round) => !round.landed && lensProvenanceSubject(round.provenance).admissible,
  )
  const identities = new Set(eligibleRounds.flatMap(({ identity }) => (identity ? [identity] : [])))
  const currentChangeCounted = Boolean(
    facts.currentRoundIdentity && identities.has(facts.currentRoundIdentity),
  )
  const budget = reviewRoundBudgetDecision({
    tier: tier.tier,
    roundsUsed: identities.size,
    currentChangeCounted,
    roundNeeded:
      unbudgetedPlan.round.lenses.length > 0 || unbudgetedPlan.round.secondOpinion !== undefined,
  })
  const budgeted = reviewPlanForBudget({
    reviewPlan: unbudgetedPlan,
    budget,
    completedLenses: roundFacts.completedLenses,
    satisfiedSecondOpinionLenses: roundFacts.satisfiedSecondOpinionLenses,
  })
  const planned = new Set(unbudgetedPlan.round.lenses)
  const completed = new Set(roundFacts.completedLenses)
  const credited = new Set(budgeted.creditedByArchitectRead.lenses)
  const running = new Map(
    facts.lensStates.filter(({ state }) => state === 'running').map((state) => [state.lens, state]),
  )
  const untriaged = new Map(
    facts.lensStates.filter(({ state }) => state === 'untriaged').map((state) => [state.lens, state]),
  )
  const overridden = new Set(facts.overriddenLenses)
  const provenanceMismatch = new Set(
    Object.entries(roundFacts.inadmissibleLenses ?? {}).flatMap(([lens, reason]) =>
      reason === 'tree-mismatch' || reason === 'commit-mismatch' ? [lens] : [],
    ),
  )
  const lensNames = [
    ...new Set([
      ...relevant.lenses,
      ...roundFacts.completedLenses,
      ...facts.lensStates.map(({ lens }) => lens),
      ...facts.overriddenLenses,
    ]),
  ]
  const lenses = lensNames.map((lens) => {
    const status: ReviewFunnelLensStatus = overridden.has(lens)
      ? 'overridden'
      : running.has(lens)
        ? 'running'
        : untriaged.has(lens)
          ? 'untriaged'
          : credited.has(lens) && facts.readCreditsRound
            ? 'credited-by-read'
            : credited.has(lens) && facts.ceilingRuling
              ? 'waived-at-ceiling'
              : planned.has(lens)
                ? 'owed'
                : completed.has(lens)
                  ? 'satisfied'
                  : 'not-applicable'
    return {
      lens,
      status,
      reason: reasonForLens({
        lens,
        plannedReason: unbudgetedPlan.round.lensReasons?.[lens],
        postFix,
        provenanceMismatch: provenanceMismatch.has(lens),
      }),
    }
  })
  const dispatch = lenses.filter(({ status }) => status === 'owed').map(({ lens }) => lens)
  const waiting = lenses.find(({ status }) => status === 'running')
  const needsTriage = lenses.find(({ status }) => status === 'untriaged')
  const waivable = ceilingWaivableGaps({
    complete: facts.triageComplete,
    unfinishedReviewNumbers: facts.admissionGap.unfinishedReviewNumbers,
    undisposedFindings: facts.admissionGap.undisposedFindings,
    missingLenses: facts.admissionGap.missingLenses,
    architectReadRequired: facts.admissionGap.architectReadRequired,
    hasNonLensGap: facts.admissionGap.nonLensGaps.length > 0,
    nonLensGaps: facts.admissionGap.nonLensGaps,
  })
  const next: ReviewFunnelVerdict['next'] = dispatch.length
    ? { action: 'dispatch', lenses: dispatch }
    : waiting
      ? { action: 'wait' }
      : needsTriage
        ? { action: 'triage' }
        : (tier.tier === 0 && !facts.exactRead) ||
            (facts.admissionGap.architectReadRequired && !facts.exactRead)
          ? { action: 'record-read' }
          : budget.atCeiling && !facts.triageComplete && waivable.waivable
            ? { action: 'ask-ceiling-ruling' }
            : { action: 'admit' }
  const remedy = (() => {
    switch (next.action) {
      case 'dispatch':
        return dispatchRemedy(facts.change, next.lenses!)
      case 'wait':
        return `bottega run wait ${running.get(waiting!.lens)!.runId}`
      case 'triage':
        return `bottega score ${untriaged.get(needsTriage!.lens)!.runId} ...`
      case 'record-read':
        return `bottega review read --sha ${facts.change.head} --note "<what was read and why it lands>"`
      case 'ask-ceiling-ruling':
        return `bottega pr create --ceiling-ruling "<why the remaining review gap is safe to waive>"`
      case 'admit':
        return 'bottega pr create'
    }
  })()
  const lowered = tier.reasons.some((reason) => reason.includes('lowered risk'))
  return {
    policyVersion,
    mode: mode(policy),
    change: facts.change,
    tier: {
      tier: tier.tier,
      risk: tier.risk,
      size: tier.size,
      firm: tier.size === 0 && tier.risk > 0 && !lowered,
      lowered,
      reasons: tier.reasons,
    },
    budget: { roundsUsed: budget.roundsUsed, ceiling: budget.ceiling, atCeiling: budget.atCeiling },
    lenses,
    next,
    remedy,
  }
}
