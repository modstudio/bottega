// concern: review-funnel-decision
/** Pure decision for everything one measured change owes the review funnel. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ReviewSettings } from '../project/project-injection.ts'
import { ceilingWaivableGaps } from '../pull-request/triage-decision.ts'
import { applicableReview, lensesSelectingPaths } from '../review/review-applicability.ts'
import type { TriageReviewRow } from '../review/review-group.ts'
import { isDecisionConformanceNotAdmittedReason } from '../review/review-lens-dispatch-reason.ts'
import {
  type LensProvenanceSubjectFacts,
  lensProvenanceSubject,
} from '../review/review-lens-provenance.ts'
import { type PostFixReviewFacts, postFixReviewDecision } from '../review/review-post-fix.ts'
import { reviewRoundBudgetDecision } from '../review/review-round-budget.ts'
import {
  applicableRoundLensPlan,
  reviewPlanForBudget,
  roundLensFacts,
} from '../review/review-round-lens-plan.ts'
import { classifyReviewTier, type ReviewTierFile } from '../review/review-tier-classifier.ts'
import {
  REVIEW_LENS_SELECTION_REASON,
  type ReviewLensOwedReason,
  type ReviewLensSelectionReason,
} from '../review/review-vocabulary.ts'
import type { ReviewFunnelPolicy } from './review-funnel-policy.ts'

type ReviewFunnelChangeIdentity = {
  project: string
  taskKey: string | null
  branch: string
  head: string
  patchId: string
  pathSet: string
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
}

type ReviewFunnelLensStatus =
  | 'owed'
  | 'running'
  | 'untriaged'
  | 'satisfied'
  | 'credited-by-read'
  | 'not-applicable'
  | 'waived-at-ceiling'
  | 'overridden'

type ReviewFunnelNextAction =
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
  lenses: { lens: string; status: ReviewFunnelLensStatus; reason: ReviewLensSelectionReason }[]
  next: { action: ReviewFunnelNextAction; lenses?: string[] }
  remedy: string
}

function mode(policy: ReviewFunnelPolicy): 'evaluate' | 'enforce' {
  return Object.values(policy.modes).every((value) => value === 'enforce') ? 'enforce' : 'evaluate'
}

const dispatchRemedy = (change: ReviewFunnelChangeIdentity, lenses: readonly string[]): string => {
  const lens = lenses[0]!
  return `${PLATFORM_SLUG} run start review-lens --review ${change.branch} --key ${change.taskKey ?? '<task-key>'} --lens ${lens} "Review ${change.branch} with ${lens}."`
}

const reviewFunnelReasons = new Set<string>(REVIEW_LENS_SELECTION_REASON)

function reasonForLens(input: {
  lens: string
  status: ReviewFunnelLensStatus
  plannedReason: ReviewLensSelectionReason | ReviewLensOwedReason | undefined
  postFix: ReturnType<typeof postFixReviewDecision>
  provenanceMismatch: ReviewLensOwedReason | undefined
}): ReviewLensSelectionReason {
  if (input.status === 'satisfied') return 'satisfied'
  if (input.status === 'credited-by-read') return 'credited-by-read'
  if (input.status === 'waived-at-ceiling') return 'waived-at-ceiling'
  if (input.status === 'overridden') return 'overridden'
  if (input.status === 'not-applicable') return 'not-applicable'
  if (
    input.provenanceMismatch === 'tree-mismatch' ||
    input.provenanceMismatch === 'commit-mismatch'
  )
    return input.provenanceMismatch
  if (input.plannedReason && isDecisionConformanceNotAdmittedReason(input.plannedReason))
    return 'operator-ordered'
  if (
    input.postFix.kind === 're-lens' &&
    Object.hasOwn(input.postFix.reOwedPathsByLens ?? {}, input.lens)
  )
    return 'rebase-changed-file'
  return input.plannedReason && reviewFunnelReasons.has(input.plannedReason)
    ? (input.plannedReason as ReviewLensSelectionReason)
    : 'initial'
}

function funnelPlan(facts: ReviewFunnelFacts) {
  const tier = classifyReviewTier({ files: facts.files, risk: facts.review?.risk })
  const postFix = postFixReviewDecision({
    facts: facts.postFix,
    tier: tier.tier,
    review: facts.review,
  })
  const relevant = applicableReview(
    tier.tier,
    facts.files.map(({ path }) => path),
    facts.review,
  )
  const roundFacts = roundLensFacts(facts.branchReviews, {
    patchId: facts.change.patchId,
    pathSet: facts.change.pathSet,
  })
  const fixPaths =
    postFix.kind === 're-lens' || postFix.kind === 'comparison-failed' ? postFix.fixPaths : []
  const planned = applicableRoundLensPlan({
    relevant,
    facts: roundFacts,
    postFix,
    fixPathsByLens: lensesSelectingPaths(fixPaths, facts.review),
  })
  const recorded = new Set(roundFacts.completedLenses)
  const admitted = new Set(facts.branchReviews.flatMap(({ lensIdentities }) => lensIdentities))
  const unrecordedAdmitted = relevant.lenses.filter(
    (lens) => admitted.has(lens) && !recorded.has(lens),
  )
  const roundLenses = relevant.lenses.filter(
    (lens) => planned.round.lenses.includes(lens) || unrecordedAdmitted.includes(lens),
  )
  const admissionLenses = relevant.lenses.filter(
    (lens) => planned.admissionRequired.lenses.includes(lens) || unrecordedAdmitted.includes(lens),
  )
  const unbudgeted = unrecordedAdmitted.length
    ? {
        ...planned,
        round: {
          ...planned.round,
          lenses: roundLenses,
          lensReasons: {
            ...Object.fromEntries(unrecordedAdmitted.map((lens) => [lens, 'initial' as const])),
            ...planned.round.lensReasons,
          },
        },
        admissionRequired: {
          ...planned.admissionRequired,
          lenses: admissionLenses,
          lensReasons: {
            ...Object.fromEntries(unrecordedAdmitted.map((lens) => [lens, 'initial' as const])),
            ...planned.admissionRequired.lensReasons,
          },
        },
      }
    : planned
  const identities = new Set(
    facts.rounds.flatMap((round) =>
      !round.landed && round.identity && lensProvenanceSubject(round.provenance).admissible
        ? [round.identity]
        : [],
    ),
  )
  const budget = reviewRoundBudgetDecision({
    tier: tier.tier,
    roundsUsed: identities.size,
    currentChangeCounted: Boolean(
      facts.currentRoundIdentity && identities.has(facts.currentRoundIdentity),
    ),
    roundNeeded: unbudgeted.round.lenses.length > 0 || unbudgeted.round.secondOpinion !== undefined,
  })
  const budgeted = reviewPlanForBudget({
    reviewPlan: unbudgeted,
    budget,
    completedLenses: roundFacts.completedLenses,
    satisfiedSecondOpinionLenses: roundFacts.satisfiedSecondOpinionLenses,
  })
  return { tier, postFix, relevant, roundFacts, unbudgeted, budget, budgeted }
}

type LensSets = {
  overridden: ReadonlySet<string>
  running: ReadonlyMap<string, ReviewFunnelLensState>
  untriaged: ReadonlyMap<string, ReviewFunnelLensState>
  credited: ReadonlySet<string>
  planned: ReadonlySet<string>
  completed: ReadonlySet<string>
}

function lensStatus(
  lens: string,
  sets: LensSets,
  readCreditsRound: boolean,
): ReviewFunnelLensStatus {
  if (sets.overridden.has(lens)) return 'overridden'
  if (sets.running.has(lens)) return 'running'
  if (sets.untriaged.has(lens)) return 'untriaged'
  if (sets.credited.has(lens)) return readCreditsRound ? 'credited-by-read' : 'waived-at-ceiling'
  if (sets.planned.has(lens)) return 'owed'
  return sets.completed.has(lens) ? 'satisfied' : 'not-applicable'
}

function lensVerdicts(facts: ReviewFunnelFacts, plan: ReturnType<typeof funnelPlan>) {
  const sets: LensSets = {
    planned: new Set(plan.unbudgeted.round.lenses),
    completed: new Set(plan.roundFacts.completedLenses),
    credited: new Set(plan.budgeted.creditedByArchitectRead.lenses),
    running: new Map(
      facts.lensStates.filter(({ state }) => state === 'running').map((row) => [row.lens, row]),
    ),
    untriaged: new Map(
      facts.lensStates.filter(({ state }) => state === 'untriaged').map((row) => [row.lens, row]),
    ),
    overridden: new Set(facts.overriddenLenses),
  }
  const provenanceMismatch = plan.roundFacts.inadmissibleLenses ?? {}
  const names = new Set([
    ...plan.relevant.lenses,
    ...plan.roundFacts.completedLenses,
    ...facts.lensStates.map(({ lens }) => lens),
    ...facts.overriddenLenses,
  ])
  return {
    sets,
    lenses: [...names].map((lens) => {
      const status = lensStatus(lens, sets, facts.readCreditsRound)
      return {
        lens,
        status,
        reason: reasonForLens({
          lens,
          status,
          plannedReason: plan.unbudgeted.round.lensReasons?.[lens],
          postFix: plan.postFix,
          provenanceMismatch: provenanceMismatch[lens],
        }),
      }
    }),
  }
}

function nextDecision(
  facts: ReviewFunnelFacts,
  plan: ReturnType<typeof funnelPlan>,
  evidence: ReturnType<typeof lensVerdicts>,
): { next: ReviewFunnelVerdict['next']; remedy: string } {
  const dispatch = evidence.lenses.filter(({ status }) => status === 'owed').map(({ lens }) => lens)
  const waiting = evidence.lenses.find(({ status }) => status === 'running')
  const untriaged = evidence.lenses.find(({ status }) => status === 'untriaged')
  const next = selectNextAction({ facts, plan, dispatch, waiting, untriaged })
  const runId = waiting
    ? evidence.sets.running.get(waiting.lens)?.runId
    : untriaged
      ? evidence.sets.untriaged.get(untriaged.lens)?.runId
      : undefined
  return { next, remedy: remedyForNext(facts, next, runId) }
}

function selectNextAction(input: {
  facts: ReviewFunnelFacts
  plan: ReturnType<typeof funnelPlan>
  dispatch: string[]
  waiting: { lens: string } | undefined
  untriaged: { lens: string } | undefined
}): ReviewFunnelVerdict['next'] {
  if (input.dispatch.length) return { action: 'dispatch', lenses: input.dispatch }
  if (input.waiting) return { action: 'wait' }
  if (input.untriaged) return { action: 'triage' }
  const readRequired = input.plan.tier.tier === 0 || input.facts.admissionGap.architectReadRequired
  if (readRequired && !input.facts.exactRead) return { action: 'record-read' }
  const ceilingGap =
    input.plan.budget.atCeiling && !input.facts.ceilingRuling && hasAdmissionGap(input.facts)
  return ceilingGap ? { action: 'ask-ceiling-ruling' } : { action: 'admit' }
}

function remedyForNext(
  facts: ReviewFunnelFacts,
  next: ReviewFunnelVerdict['next'],
  runId: string | undefined,
): string {
  const change = facts.change
  if (next.action === 'dispatch') return dispatchRemedy(change, next.lenses!)
  if (next.action === 'wait') return `${PLATFORM_SLUG} run wait ${runId}`
  if (next.action === 'triage') return `${PLATFORM_SLUG} score ${runId} ...`
  if (next.action === 'record-read')
    return `${PLATFORM_SLUG} review read --sha ${change.head} --note "<what was read and why it lands>"`
  if (next.action === 'ask-ceiling-ruling') {
    const ceiling = ceilingGapDecision(facts)
    if (ceiling.waivable)
      return `${PLATFORM_SLUG} pr create --ceiling-ruling "<why the remaining review gap is safe to waive>"`
    if (ceiling.blocker === 'unfinished-reviews')
      return `unfinished-reviews: finish reviews ${facts.admissionGap.unfinishedReviewNumbers.join(', ')}`
    if (ceiling.blocker === 'undisposed-findings')
      return `undisposed-findings: dispose findings ${facts.admissionGap.undisposedFindings
        .map(({ reviewNumber, ordinal }) => `${reviewNumber}/${ordinal}`)
        .join(', ')}`
    if (ceiling.blocker === 'non-lens-gap')
      return `non-lens-gap: clear ${facts.admissionGap.nonLensGaps.join(', ')}`
    return `${ceiling.blocker}: clear the remaining admission gap`
  }
  return `${PLATFORM_SLUG} pr create`
}

function hasAdmissionGap(facts: ReviewFunnelFacts): boolean {
  return (
    !facts.triageComplete &&
    (facts.admissionGap.unfinishedReviewNumbers.length > 0 ||
      facts.admissionGap.undisposedFindings.length > 0 ||
      facts.admissionGap.missingLenses.length > 0 ||
      facts.admissionGap.architectReadRequired ||
      facts.admissionGap.nonLensGaps.length > 0)
  )
}

function ceilingGapDecision(facts: ReviewFunnelFacts) {
  return ceilingWaivableGaps({
    complete: facts.triageComplete,
    unfinishedReviewNumbers: facts.admissionGap.unfinishedReviewNumbers,
    undisposedFindings: facts.admissionGap.undisposedFindings,
    missingLenses: facts.admissionGap.missingLenses,
    architectReadRequired: facts.admissionGap.architectReadRequired,
    hasNonLensGap: facts.admissionGap.nonLensGaps.length > 0,
    nonLensGaps: facts.admissionGap.nonLensGaps,
  })
}

/** Decide one verdict from plain gathered facts and one validated policy. */
export function decideReviewFunnel(
  facts: ReviewFunnelFacts,
  policy: ReviewFunnelPolicy,
  policyVersion = 'builtin',
): ReviewFunnelVerdict {
  const plan = funnelPlan(facts)
  const evidence = lensVerdicts(facts, plan)
  const { next, remedy } = nextDecision(facts, plan, evidence)
  return {
    policyVersion,
    mode: mode(policy),
    change: facts.change,
    tier: {
      tier: plan.tier.tier,
      risk: plan.tier.risk,
      size: plan.tier.size,
      firm: plan.tier.firm,
      lowered: plan.tier.lowered,
      reasons: plan.tier.reasons,
    },
    budget: {
      roundsUsed: plan.budget.roundsUsed,
      ceiling: plan.budget.ceiling,
      atCeiling: plan.budget.atCeiling,
    },
    lenses: evidence.lenses,
    next,
    remedy,
  }
}
