// concern: review-funnel-facts
/** Gathers repository and store facts for one review-funnel decision. */

import type { Database } from 'bun:sqlite'
import type { Project } from '../project/projects.ts'
import {
  provenanceSubjectFacts,
  reviewsForTriage,
  reviewTaskKeyForBranch,
  serializePathSet,
} from '../review/review-group.ts'
import { reviewLineage } from '../review/review-lineage-store.ts'
import { measureChangeIdentity } from '../review/review-pins.ts'
import { gatherPostFixReviewFacts } from '../review/review-post-fix.ts'
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

function landedReviewIds(database: Database, project: string): Set<string> {
  const rows = database
    .query<{ review_record_id: string }, [string]>(
      `SELECT DISTINCT CAST(item.value AS TEXT) AS review_record_id
         FROM landing_triage_snapshot snapshot
         JOIN branch_landing_record landing
           ON landing.project_record_id=snapshot.project_record_id
          AND landing.branch=snapshot.branch
          AND landing.pr_number=snapshot.pr_number
         JOIN json_each(snapshot.review_record_ids) item
        WHERE snapshot.project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND landing.merged_at IS NOT NULL`,
    )
    .all(project)
  return new Set(rows.map(({ review_record_id }) => review_record_id))
}

function reviewRoundFacts(
  database: Database,
  project: string,
  branch: string,
): ReviewFunnelRoundFact[] {
  const landed = landedReviewIds(database, project)
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

function exactRead(
  database: Database,
  project: string,
  branch: string,
  patchId: string,
  pathSet: string,
): boolean {
  const lineage = reviewLineage(database, project, branch)
  return Boolean(
    database
      .query<{ found: number }, string[]>(
        `SELECT 1 AS found FROM review_read
          WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
            AND branch IN (${lineage.map(() => '?').join(',')})
            AND patch_id=? AND path_set=? LIMIT 1`,
      )
      .get(project, ...lineage, patchId, pathSet),
  )
}

function overrideFacts(
  database: Database,
  change: { project: string; branch: string; patchId: string; pathSet: string },
): { ceilingRuling: boolean; overriddenLenses: string[] } {
  const row = database
    .query<{ attribution: string; missing_lenses: string }, [string, string, string, string]>(
      `SELECT attribution,missing_lenses FROM landing_override
        WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND branch=? AND patch_id=? AND path_set=?
        ORDER BY at DESC,record_id DESC LIMIT 1`,
    )
    .get(change.project, change.branch, change.patchId, change.pathSet)
  if (!row) return { ceilingRuling: false, overriddenLenses: [] }
  return {
    ceilingRuling: row.attribution === 'architect-ceiling',
    overriddenLenses: JSON.parse(row.missing_lenses) as string[],
  }
}

function completionFacts(
  branchReviews: ReturnType<typeof reviewsForTriage>['branchReviews'],
  exactReviews: ReturnType<typeof reviewsForTriage>['reviews'],
) {
  const incomplete = branchReviews.filter(({ completedAt }) => completedAt === null)
  const untriaged: ReviewFunnelLensState[] = incomplete.flatMap((review) =>
    review.lenses.flatMap((lens) =>
      lens.lens && lens.runId
        ? [{ lens: lens.lens, runId: lens.runId, state: 'untriaged' as const }]
        : [],
    ),
  )
  const undisposed = (rows: typeof branchReviews) =>
    rows.flatMap((review) =>
      review.findings.flatMap((finding) =>
        finding.disposition === null
          ? [{ reviewNumber: review.reviewNumber, ordinal: finding.ordinal }]
          : [],
      ),
    )
  return {
    untriaged,
    exactIncomplete: exactReviews.filter(({ completedAt }) => completedAt === null),
    exactUndisposedFindings: undisposed(exactReviews),
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
  const completion = completionFacts(reviews.branchReviews, reviews.reviews)
  const read = exactRead(
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
    triageComplete:
      read ||
      (reviews.reviews.length > 0 &&
        completion.exactIncomplete.length === 0 &&
        completion.exactUndisposedFindings.length === 0),
    admissionGap: {
      unfinishedReviewNumbers: completion.exactIncomplete.map(({ reviewNumber }) => reviewNumber),
      undisposedFindings: completion.exactUndisposedFindings,
      missingLenses: [],
      architectReadRequired: completion.hasCompletedRound && !read,
      nonLensGaps: [],
    },
  }
}
