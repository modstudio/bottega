// concern: review-post-fix
/** Finds a completed round's reviewed tip and decides whether its fix needs a narrow re-lens. */

import type { Database } from 'bun:sqlite'
import type { ReviewSettings } from '../project/project-injection.ts'
import {
  type ApplicableReview,
  applicablePostFixReview,
  applicableReview,
} from './review-applicability.ts'
import { completedReviewEvidenceSql } from './review-evidence-sql.ts'
import { serializePathSet } from './review-group.ts'
import { git, measureChangeIdentity, pinRef } from './review-pins.ts'
import { diffNumstat } from './review-tier.ts'
import {
  type ReviewTier,
  type ReviewTierFile,
  tierThreeRiskPaths,
} from './review-tier-classifier.ts'
import { type ReviewRoundEvidenceRow, reviewRoundIdentity } from './review-yield.ts'

const POST_FIX_RELENS_TIER: ReviewTier['tier'] = 3

type CompletedReview = {
  number: number
  identity: string | null
  launchKey: string | null
  runIds: string[]
}

export type PostFixReviewFacts =
  | { completed: null }
  | {
      completed: CompletedReview
      reviewedTip: string | null
      fixFiles: ReviewTierFile[] | null
    }

export type PostFixReviewDecision =
  | { kind: 'no-completed-round' }
  | { kind: 'reviewed-tip-unidentified'; reviewNumber: number }
  | {
      kind: 'no-round-needed'
      reviewNumber: number
      reviewedTip: string | null
      tierThreePaths: []
      applicability: ApplicableReview
    }
  | {
      kind: 're-lens'
      reviewNumber: number
      reviewedTip: string
      tierThreePaths: string[]
      applicability: ApplicableReview
    }

type CompletedReviewEvidenceRow = Pick<
  ReviewRoundEvidenceRow,
  'review_record_id' | 'run_id' | 'launch_key' | 'branch' | 'patch_id' | 'path_set'
> & { review_number: number }

function latestCompletedReview(
  database: Database,
  project: string,
  branch: string,
): CompletedReview | null {
  const rows = database
    .query<CompletedReviewEvidenceRow, [string, string]>(
      `SELECT r.record_id AS review_record_id,r.number AS review_number,
              run.record_id AS run_id,run.launch_key,run.branch,r.patch_id,r.path_set
         FROM review r
         JOIN review_lens rl ON rl.review_record_id=r.record_id
         JOIN run ON run.record_id=rl.run_record_id
        WHERE run.project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND run.branch=?
          AND ${completedReviewEvidenceSql('r', 'run', 'rl')}
        ORDER BY r.number DESC,rl.record_id`,
    )
    .all(project, branch)
  const first = rows[0]
  if (!first) return null
  const roundRows = rows.filter(
    ({ review_record_id }) => review_record_id === first.review_record_id,
  )
  return {
    number: first.review_number,
    identity: reviewRoundIdentity(first).identity,
    launchKey: first.launch_key,
    runIds: roundRows.map(({ run_id }) => run_id),
  }
}

function recordedReviewedTip(repo: string, to: string, review: CompletedReview): string | null {
  for (const runId of review.runIds) {
    const commit = git(repo, ['rev-parse', '--verify', `${pinRef(runId)}^{commit}`])
    if (commit.ok && git(repo, ['merge-base', '--is-ancestor', commit.out, to]).ok) {
      return commit.out
    }
  }
  return null
}

function matchingReviewedTip(
  repo: string,
  to: string,
  trunkRef: string,
  branch: string,
  review: CompletedReview,
): string | null {
  const recorded = recordedReviewedTip(repo, to, review)
  if (recorded) return recorded
  if (!review.identity) return null
  const history = git(repo, ['rev-list', '--reverse', to, '--not', trunkRef])
  if (!history.ok) return null
  let match: string | null = null
  for (const candidate of history.out.split('\n').filter(Boolean)) {
    const mergeBase = git(repo, ['merge-base', trunkRef, candidate])
    if (!mergeBase.ok) continue
    const identity = measureChangeIdentity(repo, mergeBase.out, candidate)
    if (!identity) continue
    const candidateRound = reviewRoundIdentity({
      launch_key: review.launchKey,
      branch,
      patch_id: identity.patchId,
      path_set: serializePathSet(identity.paths),
    }).identity
    if (candidateRound === review.identity) match = candidate
  }
  return match
}

function branchFixFiles(
  repo: string,
  reviewedTip: string,
  currentTip: string,
  trunkRef: string,
): ReviewTierFile[] {
  const commits = git(repo, [
    'rev-list',
    '--reverse',
    '--parents',
    currentTip,
    '--not',
    reviewedTip,
    trunkRef,
  ])
  if (!commits.ok) throw new Error(commits.err)
  const files = new Map<string, ReviewTierFile>()
  const addFiles = (changed: ReviewTierFile[]) => {
    for (const file of changed) {
      const previous = files.get(file.path)
      files.set(file.path, {
        path: file.path,
        insertions: (previous?.insertions ?? 0) + file.insertions,
        deletions: (previous?.deletions ?? 0) + file.deletions,
      })
    }
  }
  for (const row of commits.out.split('\n').filter(Boolean)) {
    const [commit, firstParent, ...mergedParents] = row.split(' ')
    if (!commit || !firstParent) throw new Error(`could not identify the parent of ${commit}`)
    const mergesLandingBranch = mergedParents.some(
      (parent) => git(repo, ['merge-base', '--is-ancestor', parent, trunkRef]).ok,
    )
    if (!mergesLandingBranch) {
      addFiles(diffNumstat(repo, firstParent, commit))
      continue
    }
    const landingParent = mergedParents.find(
      (parent) => git(repo, ['merge-base', '--is-ancestor', parent, trunkRef]).ok,
    )!
    const automatic = git(repo, [
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      firstParent,
      landingParent,
    ])
    const [automaticTree, ...conflictedPaths] = automatic.out.split('\n').filter(Boolean)
    if (!automaticTree || !git(repo, ['cat-file', '-e', `${automaticTree}^{tree}`]).ok) {
      throw new Error(automatic.err)
    }
    const resolved = diffNumstat(repo, automaticTree, commit)
    const resolvedPaths = new Set(resolved.map(({ path }) => path))
    addFiles(resolved)
    addFiles(
      conflictedPaths
        .filter((path) => !resolvedPaths.has(path))
        .map((path) => ({ path, insertions: 0, deletions: 0 })),
    )
  }
  return [...files.values()]
}

/** Gather repository and review-store evidence without making the review-policy decision. */
export function gatherPostFixReviewFacts(input: {
  database: Database
  repo: string
  to: string
  trunkRef: string
  project: string
  branch: string
}): PostFixReviewFacts {
  const completed = latestCompletedReview(input.database, input.project, input.branch)
  if (!completed) return { completed: null }
  const reviewedTip = matchingReviewedTip(
    input.repo,
    input.to,
    input.trunkRef,
    input.branch,
    completed,
  )
  if (!reviewedTip) return { completed, reviewedTip: null, fixFiles: null }
  try {
    return {
      completed,
      reviewedTip,
      fixFiles: branchFixFiles(input.repo, reviewedTip, input.to, input.trunkRef),
    }
  } catch {
    return { completed, reviewedTip: null, fixFiles: null }
  }
}

/** Decide post-fix review applicability from already-gathered facts. */
export function postFixReviewDecision(input: {
  facts: PostFixReviewFacts
  tier: ReviewTier['tier']
  review: ReviewSettings | undefined
}): PostFixReviewDecision {
  if (!input.facts.completed) return { kind: 'no-completed-round' }
  const { completed, reviewedTip, fixFiles } = input.facts
  if (input.tier !== POST_FIX_RELENS_TIER) {
    return {
      kind: 'no-round-needed',
      reviewNumber: completed.number,
      reviewedTip,
      tierThreePaths: [],
      applicability: applicableReview(0, [], input.review),
    }
  }
  if (!reviewedTip || !fixFiles) {
    return { kind: 'reviewed-tip-unidentified', reviewNumber: completed.number }
  }
  const tierThreePaths = tierThreeRiskPaths(fixFiles, input.review?.risk)
  if (tierThreePaths.length === 0) {
    return {
      kind: 'no-round-needed',
      reviewNumber: completed.number,
      reviewedTip,
      tierThreePaths: [],
      applicability: applicableReview(0, [], input.review),
    }
  }
  return {
    kind: 're-lens',
    reviewNumber: completed.number,
    reviewedTip,
    tierThreePaths,
    applicability: applicablePostFixReview(
      POST_FIX_RELENS_TIER,
      fixFiles.map(({ path }) => path),
      input.review,
    ),
  }
}
