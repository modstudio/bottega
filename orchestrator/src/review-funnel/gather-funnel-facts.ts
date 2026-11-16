// concern: review-funnel-facts
/** Gathers repository and store facts for one review-funnel decision. */

import type { Database } from 'bun:sqlite'
import { readLandedReviewIds } from '../branch/branch-landing-records.ts'
import type { Project } from '../project/projects.ts'
import type { ApplicableReview, ReviewFunnelPlan } from '../review/review-applicability.ts'
import {
  branchRunOwnerSession,
  type ChangeGroup,
  provenanceSubjectFacts,
  reviewsForAdmission,
  reviewsForTriage,
  reviewTaskKeyForBranch,
  serializePathSet,
  type TriageReviewRow,
} from '../review/review-group.ts'
import { reviewLineage } from '../review/review-lineage-store.ts'
import { git, requireChangeIdentity } from '../review/review-pins.ts'
import { gatherPostFixReviewFacts } from '../review/review-post-fix.ts'
import { hasExactArchitectRead } from '../review/review-read.ts'
import {
  currentReviewRoundIdentity,
  eligibleReviewRoundRows,
} from '../review/review-round-budget.ts'
import { reviewRoundIdentity } from '../review/review-round-identity.ts'
import {
  reviewRemoteTrunkRefExists,
  reviewTrunkRef,
  spawnGitProbe,
} from '../review/review-target.ts'
import { diffNumstat } from '../review/review-tier.ts'
import { sameStoredChange } from '../review/same-change.ts'
import { replayWitnessesForCurrent } from '../review/same-change-git.ts'
import type {
  ReviewFunnelFacts,
  ReviewFunnelLensState,
  ReviewFunnelLensStatus,
  ReviewFunnelRoundFact,
} from './decide-review-funnel.ts'
import {
  ceilingTriageFacts,
  decideTriage,
  type TriageDecision,
  type TriageReviewGroup,
} from './review-funnel-admission-evidence.ts'
import { budgetedReviewPlanForResolvedChange } from './review-funnel-plan-service.ts'
import { reviewFunnelYieldCells } from './review-funnel-yield.ts'

const RUNNING_LENS_STATUS = 'running' satisfies ReviewFunnelLensStatus
const UNTRIAGED_LENS_STATUS = 'untriaged' satisfies ReviewFunnelLensStatus

export type ExactChangeReplayContext = {
  repo: string
  base: string
  tip: string
  tree: string
  trunk: string
  witnesses: Map<string, boolean>
}

const replayRunner =
  (context: ExactChangeReplayContext) => (args: string[], stdin?: Uint8Array, stdinFile?: string) =>
    git(context.repo, args, true, stdin, stdinFile)

export type ReviewFunnelChange = {
  database: Database
  cwd: string
  base: string
  head: string
  branch: string
  project: Project
  resolved?: {
    tier: 0 | 1 | 2 | 3
    applicability: ApplicableReview
    reviewPlan?: ReviewFunnelPlan
    group: ChangeGroup
  }
  selectionWindow: number
}

function reviewRoundFacts(
  database: Database,
  project: string,
  branch: string,
): ReviewFunnelRoundFact[] {
  const landed = readLandedReviewIds(database, project, branch)
  return eligibleReviewRoundRows(database, undefined, { project, branch }).map((row) => ({
    reviewRecordId: row.review_record_id,
    identity: reviewRoundIdentity(row).identity,
    provenance: provenanceSubjectFacts(row),
    landed: landed.has(row.review_record_id),
  }))
}

function liveLensStates(
  database: Database,
  project: string,
  branch: string,
): ReviewFunnelLensState[] {
  const lineage = reviewLineage(database, project, branch)
  return database
    .query<{ lens: string; record_id: string }, string[]>(
      `SELECT lens,record_id FROM run
        WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND branch IN (${lineage.map(() => '?').join(',')})
          AND lens IS NOT NULL AND status IN ('running','asking')
        ORDER BY number`,
    )
    .all(project, ...lineage)
    .map((row) => ({ lens: row.lens, runId: row.record_id, state: RUNNING_LENS_STATUS }))
}

export function overrideFacts(
  database: Database,
  change: {
    project: string
    branch: string
    patchId: string
    zeroContextPatchId: string
    pathSet: string
  },
  replay?: ExactChangeReplayContext,
): { ceilingRuling: boolean; overriddenLenses: string[] } {
  const row = landingOverridesWithReplay(database, change, replay).find((candidate) =>
    landingOverrideMatches(candidate, change),
  )
  if (!row) return { ceilingRuling: false, overriddenLenses: [] }
  return {
    ceilingRuling: row.attribution === 'architect-ceiling',
    overriddenLenses: row.missingLenses,
  }
}

export type LandingOverrideRow = {
  recordId: string
  project: string
  branch: string
  tip: string
  tree: string
  patchId: string | null
  zeroContextPatchId: string | null
  pathSet: string | null
  attribution: 'operator' | 'architect-ceiling'
  reason: string
  missingLenses: string[]
  replayMatchesCurrent?: boolean
}

export function landingOverrideMatches(
  candidate: LandingOverrideRow,
  current: { patchId: string; zeroContextPatchId: string | null; pathSet: string },
): boolean {
  return sameStoredChange(candidate, current) || candidate.replayMatchesCurrent === true
}

export function landingOverridesWithReplay(
  database: Database,
  change: {
    project: string
    branch: string
    patchId: string
    zeroContextPatchId: string | null
    pathSet: string
  },
  replay?: ExactChangeReplayContext,
): LandingOverrideRow[] {
  const rows = readLandingOverridesForBranch(database, change.project, change.branch)
  if (!replay) return rows
  return replayWitnessesForCurrent({
    runner: replayRunner(replay),
    rows,
    current: {
      patchId: change.patchId,
      zeroContextPatchId: change.zeroContextPatchId,
      pathSet: change.pathSet,
      base: replay.base,
      tip: replay.tip,
      tree: replay.tree,
    },
    trunk: replay.trunk,
    witnesses: replay.witnesses,
  })
}

export function readLandingOverridesForBranch(
  database: Database,
  project: string,
  branch: string,
): LandingOverrideRow[] {
  return database
    .query<
      {
        recordId: string
        project: string
        branch: string
        tip: string
        tree: string
        patchId: string | null
        zeroContextPatchId: string | null
        pathSet: string | null
        attribution: 'operator' | 'architect-ceiling'
        reason: string
        missingLenses: string
      },
      [string, string]
    >(
      `SELECT record_id AS recordId,project,branch,tip,tree,patch_id AS patchId,
              zero_context_patch_id AS zeroContextPatchId,path_set AS pathSet,
              attribution,reason,missing_lenses AS missingLenses
       FROM landing_override
       WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
         AND branch=? ORDER BY at DESC,record_id DESC`,
    )
    .all(project, branch)
    .map((row) => ({
      ...row,
      missingLenses: JSON.parse(row.missingLenses) as string[],
    }))
}

function completionFacts(branchReviews: ReturnType<typeof reviewsForTriage>['branchReviews']) {
  const incomplete = branchReviews.filter(({ completedAt }) => completedAt === null)
  const untriaged: ReviewFunnelLensState[] = incomplete.flatMap((review) =>
    review.lenses.flatMap((lens) =>
      lens.lens && lens.runId
        ? [{ lens: lens.lens, runId: lens.runId, state: UNTRIAGED_LENS_STATUS }]
        : [],
    ),
  )
  return {
    untriaged,
    hasCompletedRound: branchReviews.some(
      ({ completedAt, tier }) => completedAt !== null && tier !== null,
    ),
  }
}

type AdmissionEvidenceChange = NonNullable<ReviewFunnelChange['resolved']> & {
  project: Project
  branch: string
}

export function gatherAdmissionEvidenceDecision(
  change: AdmissionEvidenceChange,
  database: Database,
  replay?: ExactChangeReplayContext,
): TriageDecision {
  const reviews = reviewsForAdmission(database, change.group)
  const lineage = reviewLineage(database, change.project.name, change.branch)
  const grouped = new Map<string, TriageReviewRow[]>()
  for (const review of reviews.branchReviews) {
    if (review.patchId === null || review.pathSet === null) continue
    const key = JSON.stringify([review.patchId, review.pathSet])
    grouped.set(key, [...(grouped.get(key) ?? []), review])
  }
  const branchReviewGroups: TriageReviewGroup[] = [...grouped.values()].map((rows) => ({
    reviews: rows,
  }))
  const readRows = database
    .query<
      {
        record_id: string
        tip: string
        patch_id: string
        zero_context_patch_id: string | null
        path_set: string
        recorded_at: string
        session_id: string | null
      },
      string[]
    >(
      `SELECT record_id,tip,patch_id,zero_context_patch_id,path_set,recorded_at,session_id FROM review_read
      WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
        AND branch IN (${lineage.map(() => '?').join(',')})
      ORDER BY recorded_at DESC,record_id DESC`,
    )
    .all(change.project.name, ...lineage)
    .map((row) => ({
      recordId: row.record_id,
      tip: row.tip,
      patchId: row.patch_id,
      zeroContextPatchId: row.zero_context_patch_id,
      pathSet: row.path_set,
      recordedAt: row.recorded_at,
      sessionId: row.session_id,
    }))
  const witnessedReads = replay
    ? replayWitnessesForCurrent({
        runner: replayRunner(replay),
        rows: readRows,
        current: {
          patchId: change.group.patchId,
          zeroContextPatchId: change.group.zeroContextPatchId,
          pathSet: serializePathSet(change.group.pathSet),
          base: replay.base,
          tip: replay.tip,
          tree: replay.tree,
        },
        trunk: replay.trunk,
        witnesses: replay.witnesses,
      })
    : readRows
  return decideTriage({
    patchId: change.group.patchId,
    zeroContextPatchId: change.group.zeroContextPatchId,
    pathSet: serializePathSet(change.group.pathSet),
    tier: change.tier,
    applicableReview: change.applicability,
    reviewPlan: change.reviewPlan,
    branchOwnerSession: branchRunOwnerSession(database, change.project.name, change.branch),
    reviews: reviews.reviews,
    branchReviewGroups,
    reads: witnessedReads.map(({ tip: _tip, ...read }) => read),
  })
}

function gatheredTriage(
  change: ReviewFunnelChange,
  group: ChangeGroup,
  replay: ExactChangeReplayContext,
) {
  const resolved =
    change.resolved ??
    (() => {
      const plan = budgetedReviewPlanForResolvedChange({
        database: change.database,
        cwd: change.cwd,
        base: change.base,
        commit: change.head,
        branch: change.branch,
        project: change.project,
      })
      return {
        tier: plan.output.tier,
        applicability: plan.relevant,
        reviewPlan: plan.reviewPlan,
        group,
      }
    })()
  return gatherAdmissionEvidenceDecision(
    { ...resolved, project: change.project, branch: change.branch },
    change.database,
    replay,
  )
}

function exactChangeReplayContext(change: ReviewFunnelChange): ExactChangeReplayContext {
  const trunk = change.project.settings.trunk?.trim()
  if (!trunk) throw new Error(`project ${change.project.name} has no trunk configured`)
  const trunkRef = reviewTrunkRef(
    reviewRemoteTrunkRefExists(trunk, spawnGitProbe(change.cwd)),
    trunk,
  )
  const tree = git(change.cwd, ['rev-parse', '--verify', `${change.head}^{tree}`])
  if (!tree.ok) throw new Error(`could not resolve tree for ${change.head}: ${tree.err}`)
  return {
    repo: change.cwd,
    base: change.base,
    tip: change.head,
    tree: tree.out,
    trunk: trunkRef,
    witnesses: new Map(),
  }
}

/** Resolve one change once, including lineage evidence and completed-landing exclusions. */
export function gatherFunnelFacts(change: ReviewFunnelChange): ReviewFunnelFacts {
  const identity = requireFunnelChangeIdentity(change.branch, () =>
    requireChangeIdentity(change.cwd, change.base, change.head),
  )
  const pathSet = serializePathSet(identity.paths)
  const group = {
    project: change.project.name,
    branch: change.branch,
    patchId: identity.patchId,
    zeroContextPatchId: identity.zeroContextPatchId,
    pathSet: identity.paths,
  }
  const reviews = reviewsForTriage(change.database, group)
  const files = diffNumstat(change.cwd, change.base, change.head)
  const replay = exactChangeReplayContext(change)
  const postFix = gatherPostFixReviewFacts({
    database: change.database,
    repo: change.cwd,
    to: change.head,
    trunkRef: replay.trunk,
    project: change.project.name,
    branch: change.branch,
  })
  const completion = completionFacts(reviews.branchReviews)
  const read = hasExactArchitectRead(
    change.database,
    change.project.name,
    change.branch,
    identity.patchId,
    identity.zeroContextPatchId,
    pathSet,
    replay,
  )
  const overrides = overrideFacts(
    change.database,
    {
      project: change.project.name,
      branch: change.branch,
      patchId: identity.patchId,
      zeroContextPatchId: identity.zeroContextPatchId,
      pathSet,
    },
    replay,
  )
  const admission = gatheredTriage(change, group, replay)
  const admissionGap = ceilingTriageFacts(admission)
  return {
    change: {
      project: change.project.name,
      taskKey: reviewTaskKeyForBranch(change.database, change.project.name, change.branch),
      branch: change.branch,
      head: change.head,
      patchId: identity.patchId,
      zeroContextPatchId: identity.zeroContextPatchId,
      pathSet,
      paths: identity.paths,
    },
    stack: change.project.stack,
    yieldCells: reviewFunnelYieldCells(change.database, change.selectionWindow),
    files,
    review: change.project.settings.review,
    branchReviews: reviews.branchReviews,
    postFix,
    rounds: reviewRoundFacts(change.database, change.project.name, change.branch),
    currentRoundIdentity: currentReviewRoundIdentity({
      branch: change.branch,
      patchId: identity.patchId,
      pathSet,
    }),
    lensStates: [
      ...liveLensStates(change.database, change.project.name, change.branch),
      ...completion.untriaged,
    ],
    exactRead: read,
    readCreditsRound: read && completion.hasCompletedRound,
    ...overrides,
    triageComplete: admission.complete,
    admissionGap: {
      unfinishedReviewNumbers: [...admissionGap.unfinishedReviewNumbers],
      undisposedFindings: [...admissionGap.undisposedFindings],
      missingLenses: [...admissionGap.missingLenses],
      architectReadRequired: admissionGap.architectReadRequired,
      nonLensGaps: [...admissionGap.nonLensGaps],
    },
  }
}

export function requireFunnelChangeIdentity<T>(branch: string, measure: () => T): T {
  try {
    return measure()
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`could not measure review-funnel change ${branch}: ${detail}`)
  }
}
