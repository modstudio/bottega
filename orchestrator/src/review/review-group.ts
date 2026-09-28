// concern: review-group
/** Measures change groups and reads their recorded review rows. */
import type { Database } from 'bun:sqlite'
import type { Project } from '../project/projects.ts'
import { measureChangeIdentity } from './review-pins.ts'
import { resolveReviewMergeBase } from './review-target.ts'
import { classifyReviewTier, diffNumstat, type ReviewTier } from './review-tier.ts'

export type ChangeGroup = {
  project: string
  branch: string
  patchId: string
  pathSet: string[]
}

export type TriageReviewRow = {
  reviewId: number
  recordedAt: string
  completedAt: string | null
  tier: 0 | 1 | 2 | 3 | null
  patchId: string | null
  pathSet: string | null
  lensIds: readonly number[]
  findings: readonly { id: number; ordinal: number; disposition: string | null }[]
}

export type MeasuredChangeGroup = {
  group: ChangeGroup
  base: string
  tier: ReviewTier
  message: string
}

export type MeasuredReviewChange = {
  patchId: string
  pathSet: string[]
  base: string
  tier: ReviewTier
  message: string
}

type ChangeGroupOperations = {
  mergeBase(cwd: string, tip: string, trunk: string): string | null
  identity(
    cwd: string,
    base: string,
    tip: string,
  ): { patchId: string; paths: string[]; message: string } | null
  tier(cwd: string, base: string, tip: string): ReviewTier
}

const changeGroupOperations: ChangeGroupOperations = {
  mergeBase: resolveReviewMergeBase,
  identity: measureChangeIdentity,
  tier: (cwd, base, tip) => classifyReviewTier({ files: diffNumstat(cwd, base, tip) }),
}

export const serializePathSet = (paths: readonly string[]): string =>
  JSON.stringify([...paths].sort())

/** Session that owns the root run chain which minted or works on this branch. */
export function branchRunOwnerSession(
  database: Database,
  project: string,
  branch: string,
): string | null {
  const row = database
    .query<{ session_id: string | null }, [string, string, string]>(
      `SELECT session_id FROM run
        WHERE parent_run_id IS NULL AND repo=? AND (branch=? OR minted_branch=?)
        ORDER BY id DESC LIMIT 1`,
    )
    .get(project, branch, branch)
  return row?.session_id ?? null
}

/** Measure the one review identity used at review recording and PR admission. */
export function measureReviewChange(
  cwd: string,
  project: Pick<Project, 'name' | 'settings'>,
  tip: string,
  operations: ChangeGroupOperations = changeGroupOperations,
): MeasuredReviewChange | null {
  const trunk = project.settings.trunk?.trim()
  if (!trunk) throw new Error(`project ${project.name} has no trunk configured`)
  const base = operations.mergeBase(cwd, tip, trunk)
  if (!base) return null
  const identity = operations.identity(cwd, base, tip)
  if (!identity) return null
  return {
    patchId: identity.patchId,
    pathSet: identity.paths,
    base,
    tier: operations.tier(cwd, base, tip),
    message: identity.message,
  }
}

/** Attach the branch component required by admission to a measured review change. */
export function measureChangeGroup(
  cwd: string,
  project: Pick<Project, 'name' | 'settings'>,
  branch: string,
  tip: string,
  operations: ChangeGroupOperations = changeGroupOperations,
): MeasuredChangeGroup | null {
  const measured = measureReviewChange(cwd, project, tip, operations)
  if (!measured) return null
  return {
    group: {
      project: project.name,
      branch,
      patchId: measured.patchId,
      pathSet: measured.pathSet,
    },
    base: measured.base,
    tier: measured.tier,
    message: measured.message,
  }
}

export function reviewsForChangeGroup(database: Database, group: ChangeGroup): TriageReviewRow[] {
  return reviewsForTriage(database, group).reviews
}

export function reviewsForTriage(
  database: Database,
  group: ChangeGroup,
): { reviews: TriageReviewRow[]; branchReviews: TriageReviewRow[] } {
  const branchReviews = reviewsForBranch(database, group.project, group.branch)
  const pathSet = serializePathSet(group.pathSet)
  return {
    branchReviews,
    reviews: branchReviews.filter(
      (review) => review.patchId === group.patchId && review.pathSet === pathSet,
    ),
  }
}

/** All review rounds recorded by runs on a branch, newest first. */
export function reviewsForBranch(
  database: Database,
  project: string,
  branch: string,
): TriageReviewRow[] {
  const rows = database
    .query<
      {
        review_id: number
        recorded_at: string
        completed_at: string | null
        tier: 0 | 1 | 2 | 3 | null
        patch_id: string | null
        path_set: string | null
        lens_id: number
        finding_id: number | null
        ordinal: number | null
        disposition: string | null
      },
      [string, string]
    >(
      `SELECT r.id review_id,r.recorded_at,r.completed_at,r.tier,r.patch_id,r.path_set,rl.id lens_id,
              rf.id finding_id,rf.ordinal,rf.disposition
         FROM review r JOIN review_lens rl ON rl.review_id=r.id
         JOIN run ON run.id=rl.run_id
         LEFT JOIN review_finding rf ON rf.review_id=r.id
        WHERE run.repo=? AND run.branch=? ORDER BY r.id DESC,rl.id,rf.id`,
    )
    .all(project, branch)
  const reviews = new Map<number, TriageReviewRow>()
  for (const row of rows) {
    const review = reviews.get(row.review_id) ?? {
      reviewId: row.review_id,
      recordedAt: row.recorded_at,
      completedAt: row.completed_at,
      tier: row.tier,
      patchId: row.patch_id,
      pathSet: row.path_set,
      lensIds: [],
      findings: [],
    }
    if (!review.lensIds.includes(row.lens_id)) (review.lensIds as number[]).push(row.lens_id)
    if (
      row.finding_id !== null &&
      !review.findings.some((finding) => finding.id === row.finding_id)
    ) {
      ;(review.findings as { id: number; ordinal: number; disposition: string | null }[]).push({
        id: row.finding_id,
        ordinal: row.ordinal!,
        disposition: row.disposition,
      })
    }
    reviews.set(row.review_id, review)
  }
  return [...reviews.values()]
}
