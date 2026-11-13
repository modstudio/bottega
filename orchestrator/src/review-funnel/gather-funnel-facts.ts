// concern: review-funnel-facts
/** Gathers repository and store facts for one review-funnel decision. */

import type { Database } from 'bun:sqlite'
import { readLandedReviewIds } from '../branch/branch-landing-records.ts'
import type { Project } from '../project/projects.ts'
import {
  readLandingOverridesForBranch,
  resolvePullRequestChangeForProject,
  triageDecision,
} from '../pull-request/pr-admission.ts'
import { ceilingTriageFacts } from '../pull-request/triage-decision.ts'
import {
  provenanceSubjectFacts,
  reviewsForTriage,
  reviewTaskKeyForBranch,
  serializePathSet,
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
  ReviewFunnelRoundFact,
} from './decide-review-funnel.ts'

export type ReviewFunnelChange = {
  database: Database
  cwd: string
  base: string
  head: string
  branch: string
  project: Project
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
    .map((row) => ({ lens: row.lens, runId: row.record_id, state: 'running' as const }))
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

function completionFacts(branchReviews: ReturnType<typeof reviewsForTriage>['branchReviews']) {
  const incomplete = branchReviews.filter(({ completedAt }) => completedAt === null)
  const untriaged: ReviewFunnelLensState[] = incomplete.flatMap((review) =>
    review.lenses.flatMap((lens) =>
      lens.lens && lens.runId
        ? [{ lens: lens.lens, runId: lens.runId, state: 'untriaged' as const }]
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
  const admission = triageDecision(
    resolvePullRequestChangeForProject(
      change.cwd,
      change.project,
      change.branch,
      change.head,
      change.database,
    ),
    change.database,
  )
  const admissionGap = ceilingTriageFacts(admission)
  return {
    change: {
      project: change.project.name,
      taskKey: reviewTaskKeyForBranch(change.database, change.project.name, change.branch),
      branch: change.branch,
      head: change.head,
      patchId: identity.patchId,
      paths: identity.paths,
    },
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
