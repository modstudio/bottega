// concern: review-post-fix
/** Finds a completed round's reviewed tip and decides whether its fix needs a narrow re-lens. */

import type { Database } from 'bun:sqlite'
import type { ReviewSettings } from '../project/project-injection.ts'
import { type ApplicableReview, applicableReview } from './review-applicability.ts'
import { serializePathSet } from './review-group.ts'
import { git, measureChangeIdentity, pinRef } from './review-pins.ts'
import { tierThreeRiskPaths } from './review-tier.ts'

type CompletedReview = {
  number: number
  patchId: string | null
  pathSet: string | null
  runIds: string[]
}

export type PostFixReviewDecision =
  | { kind: 'no-completed-round' }
  | { kind: 'reviewed-tip-unidentified'; reviewNumber: number }
  | {
      kind: 'no-round-needed'
      reviewNumber: number
      reviewedTip: string
      tierThreePaths: []
    }
  | {
      kind: 're-lens'
      reviewNumber: number
      reviewedTip: string
      tierThreePaths: string[]
      applicability: ApplicableReview
    }

function latestCompletedReview(
  database: Database,
  project: string,
  branch: string,
): CompletedReview | null {
  const rows = database
    .query<
      {
        number: number
        patch_id: string | null
        path_set: string | null
        run_record_id: string
      },
      [string, string]
    >(
      `SELECT r.number,r.patch_id,r.path_set,rl.run_record_id
         FROM review r
         JOIN review_lens rl ON rl.review_record_id=r.record_id
         JOIN run ON run.record_id=rl.run_record_id
        WHERE r.completed_at IS NOT NULL
          AND run.project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND run.branch=?
        ORDER BY r.number DESC,rl.record_id`,
    )
    .all(project, branch)
  const first = rows[0]
  if (!first) return null
  return {
    number: first.number,
    patchId: first.patch_id,
    pathSet: first.path_set,
    runIds: rows
      .filter(({ number }) => number === first.number)
      .map(({ run_record_id }) => run_record_id),
  }
}

function matchingReviewedTip(
  repo: string,
  from: string,
  to: string,
  review: CompletedReview,
): string | null {
  if (!review.patchId || !review.pathSet) return null
  if (!review.runIds.some((runId) => git(repo, ['rev-parse', '--verify', pinRef(runId)]).ok)) {
    return null
  }
  const history = git(repo, ['rev-list', '--reverse', '--ancestry-path', `${from}..${to}`])
  if (!history.ok) return null
  let match: string | null = null
  for (const candidate of history.out.split('\n').filter(Boolean)) {
    const identity = measureChangeIdentity(repo, from, candidate)
    if (
      identity?.patchId === review.patchId &&
      serializePathSet(identity.paths) === review.pathSet
    ) {
      match = candidate
    }
  }
  return match
}

function pathsTouchedByCommits(repo: string, from: string, to: string): string[] | null {
  const result = git(repo, ['log', '--format=', '--name-only', `${from}..${to}`])
  if (!result.ok) return null
  return [...new Set(result.out.split('\n').filter(Boolean))].sort()
}

export function postFixReviewDecision(input: {
  database: Database
  repo: string
  from: string
  to: string
  project: string
  branch: string
  tier: 0 | 1 | 2 | 3
  review: ReviewSettings | undefined
}): PostFixReviewDecision {
  const completed = latestCompletedReview(input.database, input.project, input.branch)
  if (!completed) return { kind: 'no-completed-round' }
  const reviewedTip = matchingReviewedTip(input.repo, input.from, input.to, completed)
  if (!reviewedTip) {
    return { kind: 'reviewed-tip-unidentified', reviewNumber: completed.number }
  }
  const fixPaths = pathsTouchedByCommits(input.repo, reviewedTip, input.to)
  if (!fixPaths) {
    return { kind: 'reviewed-tip-unidentified', reviewNumber: completed.number }
  }
  const fixFiles = fixPaths.map((path) => ({ path, insertions: 0, deletions: 0 }))
  const tierThreePaths = tierThreeRiskPaths(fixFiles, input.review?.risk)
  if (input.tier !== 3 || tierThreePaths.length === 0) {
    return {
      kind: 'no-round-needed',
      reviewNumber: completed.number,
      reviewedTip,
      tierThreePaths: [],
    }
  }
  return {
    kind: 're-lens',
    reviewNumber: completed.number,
    reviewedTip,
    tierThreePaths,
    applicability: applicableReview(3, fixPaths, input.review),
  }
}
