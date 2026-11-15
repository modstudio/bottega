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
import { measureChangeIdentity } from '../review/review-pins.ts'
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

const RUNNING_LENS_STATUS = 'running' satisfies ReviewFunnelLensStatus
const UNTRIAGED_LENS_STATUS = 'untriaged' satisfies ReviewFunnelLensStatus

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
}

function reviewRoundFacts(
  database: Database,
  project: string,
  branch: string,
): ReviewFunnelRoundFact[] {
  const landed = readLandedReviewIds(database, project)
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

function overrideFacts(
  database: Database,
  change: { project: string; branch: string; patchId: string; pathSet: string },
): { ceilingRuling: boolean; overriddenLenses: string[] } {
  const row = readLandingOverridesForBranch(database, change.project, change.branch).find(
    ({ patchId, pathSet }) => patchId === change.patchId && pathSet === change.pathSet,
  )
  if (!row) return { ceilingRuling: false, overriddenLenses: [] }
  return {
    ceilingRuling: row.attribution === 'architect-ceiling',
    overriddenLenses: row.missingLenses,
  }
}

export function readLandingOverridesForBranch(
  database: Database,
  project: string,
  branch: string,
): Array<{
  recordId: string
  project: string
  branch: string
  tip: string
  tree: string
  patchId: string | null
  pathSet: string | null
  attribution: 'operator' | 'architect-ceiling'
  reason: string
  missingLenses: string[]
}> {
  return database
    .query<
      {
        recordId: string
        project: string
        branch: string
        tip: string
        tree: string
        patchId: string | null
        pathSet: string | null
        attribution: 'operator' | 'architect-ceiling'
        reason: string
        missingLenses: string
      },
      [string, string]
    >(
      `SELECT record_id AS recordId,project,branch,tip,tree,patch_id AS patchId,path_set AS pathSet,
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
  return decideTriage({
    patchId: change.group.patchId,
    pathSet: serializePathSet(change.group.pathSet),
    tier: change.tier,
    applicableReview: change.applicability,
    reviewPlan: change.reviewPlan,
    branchOwnerSession: branchRunOwnerSession(database, change.project.name, change.branch),
    reviews: reviews.reviews,
    branchReviewGroups,
    reads: database
      .query<
        {
          record_id: string
          patch_id: string
          path_set: string
          recorded_at: string
          session_id: string | null
        },
        string[]
      >(
        `SELECT record_id,patch_id,path_set,recorded_at,session_id FROM review_read
        WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND branch IN (${lineage.map(() => '?').join(',')})
        ORDER BY recorded_at DESC,record_id DESC`,
      )
      .all(change.project.name, ...lineage)
      .map((row) => ({
        recordId: row.record_id,
        patchId: row.patch_id,
        pathSet: row.path_set,
        recordedAt: row.recorded_at,
        sessionId: row.session_id,
      })),
  })
}

function gatheredTriage(change: ReviewFunnelChange, group: ChangeGroup) {
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
        applicability: {
          lenses: plan.output.lenses,
          ...(plan.output.secondOpinion ? { secondOpinion: plan.output.secondOpinion } : {}),
          ...(plan.output.lensBases ? { lensBases: plan.output.lensBases } : {}),
          ...(plan.output.secondOpinionBasis
            ? { secondOpinionBasis: plan.output.secondOpinionBasis }
            : {}),
        },
        reviewPlan: plan.reviewPlan,
        group,
      }
    })()
  return gatherAdmissionEvidenceDecision(
    { ...resolved, project: change.project, branch: change.branch },
    change.database,
  )
}

/** Resolve one change once, including lineage evidence and completed-landing exclusions. */
export function gatherFunnelFacts(change: ReviewFunnelChange): ReviewFunnelFacts {
  const identity = measureChangeIdentity(change.cwd, change.base, change.head)
  if (!identity) throw new Error(`could not measure review-funnel change ${change.branch}`)
  const pathSet = serializePathSet(identity.paths)
  const group = {
    project: change.project.name,
    branch: change.branch,
    patchId: identity.patchId,
    pathSet: identity.paths,
  }
  const reviews = reviewsForTriage(change.database, group)
  const files = diffNumstat(change.cwd, change.base, change.head)
  const trunk = change.project.settings.trunk?.trim()
  if (!trunk) throw new Error(`project ${change.project.name} has no trunk configured`)
  const postFix = gatherPostFixReviewFacts({
    database: change.database,
    repo: change.cwd,
    to: change.head,
    trunkRef: reviewTrunkRef(reviewRemoteTrunkRefExists(trunk, spawnGitProbe(change.cwd)), trunk),
    project: change.project.name,
    branch: change.branch,
  })
  const completion = completionFacts(reviews.branchReviews)
  const read = hasExactArchitectRead(
    change.database,
    change.project.name,
    change.branch,
    identity.patchId,
    pathSet,
  )
  const overrides = overrideFacts(change.database, {
    project: change.project.name,
    branch: change.branch,
    patchId: identity.patchId,
    pathSet,
  })
  const admission = gatheredTriage(change, group)
  const admissionGap = ceilingTriageFacts(admission)
  return {
    change: {
      project: change.project.name,
      taskKey: reviewTaskKeyForBranch(change.database, change.project.name, change.branch),
      branch: change.branch,
      head: change.head,
      patchId: identity.patchId,
      pathSet,
      paths: identity.paths,
    },
    stack: change.project.stack,
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
