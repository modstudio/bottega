// concern: review-funnel-decision
/** Pure decision for everything one measured change owes the review funnel. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ReviewSettings } from '../project/project-injection.ts'
import { ceilingWaivableGaps } from '../pull-request/triage-decision.ts'
import { applicableReview, lensesSelectingPaths } from '../review/review-applicability.ts'
import type { TriageReviewRow } from '../review/review-group.ts'
import {
  type LensProvenanceSubjectFacts,
  lensProvenanceSubject,
} from '../review/review-lens-provenance.ts'
import {
  type PostFixReviewFacts,
  postFixReviewDecision,
  type RebaseFileComparison,
  rebaseCarryDecision,
} from '../review/review-post-fix.ts'
import { reviewRoundBudgetDecision } from '../review/review-round-budget.ts'
import {
  applicableRoundLensPlan,
  reviewPlanForBudget,
  roundLensFacts,
} from '../review/review-round-lens-plan.ts'
import { classifyReviewTier, type ReviewTierFile } from '../review/review-tier-classifier.ts'
import type { ReviewFunnelPolicy } from './review-funnel-policy.ts'

type ReviewFunnelChangeIdentity = {
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
  lenses: { lens: string; status: ReviewFunnelLensStatus; reason: string }[]
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

function funnelPlan(facts: ReviewFunnelFacts) {
  const tier = classifyReviewTier({ files: facts.files, risk: facts.review?.risk })
  const rebase = facts.rebase ? rebaseCarryDecision(facts.rebase) : null
  const postFixFacts =
    rebase && facts.postFix.completed
      ? { ...facts.postFix, fixFiles: rebase.fixFiles, reOwedPathsByLens: rebase.reOwedPathsByLens }
      : facts.postFix
  const postFix = postFixReviewDecision({
    facts: postFixFacts,
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
    pathSet: JSON.stringify([...facts.change.paths].sort()),
  })
  const fixPaths =
    postFix.kind === 're-lens' || postFix.kind === 'comparison-failed' ? postFix.fixPaths : []
  const unbudgeted = applicableRoundLensPlan({
    relevant,
    facts: roundFacts,
    postFix,
    fixPathsByLens: lensesSelectingPaths(fixPaths, facts.review),
  })
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
  const provenanceMismatch = new Set(
    Object.entries(plan.roundFacts.inadmissibleLenses ?? {}).flatMap(([lens, reason]) =>
      reason === 'tree-mismatch' || reason === 'commit-mismatch' ? [lens] : [],
    ),
  )
  const names = new Set([
    ...plan.relevant.lenses,
    ...plan.roundFacts.completedLenses,
    ...facts.lensStates.map(({ lens }) => lens),
    ...facts.overriddenLenses,
  ])
  return {
    sets,
    lenses: [...names].map((lens) => ({
      lens,
      status: lensStatus(lens, sets, facts.readCreditsRound),
      reason: reasonForLens({
        lens,
        plannedReason: plan.unbudgeted.round.lensReasons?.[lens],
        postFix: plan.postFix,
        provenanceMismatch: provenanceMismatch.has(lens),
      }),
    })),
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
  return { next, remedy: remedyForNext(facts.change, next, runId) }
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
    input.plan.budget.atCeiling && !input.facts.triageComplete && ceilingGapIsWaivable(input.facts)
  return ceilingGap ? { action: 'ask-ceiling-ruling' } : { action: 'admit' }
}

function remedyForNext(
  change: ReviewFunnelChangeIdentity,
  next: ReviewFunnelVerdict['next'],
  runId: string | undefined,
): string {
  if (next.action === 'dispatch') return dispatchRemedy(change, next.lenses!)
  if (next.action === 'wait') return `${PLATFORM_SLUG} run wait ${runId}`
  if (next.action === 'triage') return `${PLATFORM_SLUG} score ${runId} ...`
  if (next.action === 'record-read')
    return `${PLATFORM_SLUG} review read --sha ${change.head} --note "<what was read and why it lands>"`
  if (next.action === 'ask-ceiling-ruling')
    return `${PLATFORM_SLUG} pr create --ceiling-ruling "<why the remaining review gap is safe to waive>"`
  return `${PLATFORM_SLUG} pr create`
}

function ceilingGapIsWaivable(facts: ReviewFunnelFacts): boolean {
  return ceilingWaivableGaps({
    complete: facts.triageComplete,
    unfinishedReviewNumbers: facts.admissionGap.unfinishedReviewNumbers,
    undisposedFindings: facts.admissionGap.undisposedFindings,
    missingLenses: facts.admissionGap.missingLenses,
    architectReadRequired: facts.admissionGap.architectReadRequired,
    hasNonLensGap: facts.admissionGap.nonLensGaps.length > 0,
    nonLensGaps: facts.admissionGap.nonLensGaps,
  }).waivable
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
  const lowered = plan.tier.reasons.some((reason) => reason.includes('lowered risk'))
  return {
    policyVersion,
    mode: mode(policy),
    change: facts.change,
    tier: {
      tier: plan.tier.tier,
      risk: plan.tier.risk,
      size: plan.tier.size,
      firm: plan.tier.size === 0 && plan.tier.risk > 0 && !lowered,
      lowered,
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
