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
  reviewRecordId: string
  reviewNumber: number
  recordedAt: string
  completedAt: string | null
  tier: 0 | 1 | 2 | 3 | null
  patchId: string | null
  pathSet: string | null
  lensIdentities: readonly string[]
  lenses: readonly {
    recordId: string
    runId?: string
    lens?: string
    model?: string | null
    graded: boolean
  }[]
  findings: readonly { recordId: string; ordinal: number; disposition: string | null }[]
}

/** The triage floor shared by workflow evidence and project review recording. */
export function reviewRoundTriageComplete(review: TriageReviewRow): boolean {
  return (
    review.lenses.length > 0 &&
    review.lenses.every(({ graded }) => graded) &&
    review.findings.every(({ disposition }) => disposition !== null)
  )
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
  tier(
    cwd: string,
    base: string,
    tip: string,
    risk: NonNullable<Project['settings']['review']>['risk'],
  ): ReviewTier
}

const changeGroupOperations: ChangeGroupOperations = {
  mergeBase: resolveReviewMergeBase,
  identity: measureChangeIdentity,
  tier: (cwd, base, tip, risk) => classifyReviewTier({ files: diffNumstat(cwd, base, tip), risk }),
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
        WHERE parent_run_record_id IS NULL
          AND project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND (branch=? OR minted_branch=?)
        ORDER BY number DESC LIMIT 1`,
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
    tier: operations.tier(cwd, base, tip, project.settings.review?.risk),
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

function reviewsForChangeGroup(
  branchReviews: readonly TriageReviewRow[],
  group: ChangeGroup,
): TriageReviewRow[] {
  const pathSet = serializePathSet(group.pathSet)
  return branchReviews.filter(
    (review) => review.patchId === group.patchId && review.pathSet === pathSet,
  )
}

export function reviewsForTriage(
  database: Database,
  group: ChangeGroup,
  includeReviewId?: string,
): { reviews: TriageReviewRow[]; branchReviews: TriageReviewRow[] } {
  const branchReviews = reviewsForBranch(database, group.project, group.branch, includeReviewId)
  return {
    branchReviews,
    reviews: reviewsForChangeGroup(branchReviews, group),
  }
}

/** All review rounds recorded by runs on a branch, newest first. */
function reviewsForBranch(
  database: Database,
  project: string,
  branch: string,
  includeReviewId?: string,
): TriageReviewRow[] {
  const rows = database
    .query<
      {
        review_record_id: string
        review_number: number
        recorded_at: string
        completed_at: string | null
        tier: 0 | 1 | 2 | 3 | null
        patch_id: string | null
        path_set: string | null
        lens_id: string
        run_record_id: string
        lens: string
        model: string | null
        reproduced: string | null
        coverage: string | null
        limits: string | null
        overlap: string | null
        finding_id: string | null
        ordinal: number | null
        disposition: string | null
      },
      [string, string, string | null]
    >(
      `SELECT r.record_id review_record_id,r.number review_number,r.recorded_at,r.completed_at,r.tier,r.patch_id,r.path_set,
              rl.record_id lens_id,rl.run_record_id,rl.lens,rl.model,rl.reproduced,rl.coverage,rl.limits,rl.overlap,
              rf.record_id finding_id,rf.ordinal,rf.disposition
         FROM review r JOIN review_lens rl ON rl.review_record_id=r.record_id
         JOIN run ON run.record_id=rl.run_record_id
         LEFT JOIN review_finding rf ON rf.review_record_id=r.record_id
        WHERE run.project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND (run.branch=? OR r.record_id=?) ORDER BY r.number DESC,rl.record_id,rf.ordinal`,
    )
    .all(project, branch, includeReviewId ?? null)
  const reviews = new Map<string, TriageReviewRow>()
  for (const row of rows) {
    const review = reviews.get(row.review_record_id) ?? {
      reviewRecordId: row.review_record_id,
      reviewNumber: row.review_number,
      recordedAt: row.recorded_at,
      completedAt: row.completed_at,
      tier: row.tier,
      patchId: row.patch_id,
      pathSet: row.path_set,
      lensIdentities: [],
      lenses: [],
      findings: [],
    }
    if (!review.lensIdentities.includes(row.lens)) {
      ;(review.lensIdentities as string[]).push(row.lens)
    }
    if (!review.lenses.some((lens) => lens.recordId === row.lens_id)) {
      ;(
        review.lenses as {
          recordId: string
          runId: string
          lens: string
          model: string | null
          graded: boolean
        }[]
      ).push({
        recordId: row.lens_id,
        runId: row.run_record_id,
        lens: row.lens,
        model: row.model,
        graded:
          row.reproduced !== null &&
          row.coverage !== null &&
          row.limits !== null &&
          row.overlap !== null,
      })
    }
    if (
      row.finding_id !== null &&
      !review.findings.some((finding) => finding.recordId === row.finding_id)
    ) {
      ;(
        review.findings as { recordId: string; ordinal: number; disposition: string | null }[]
      ).push({
        recordId: row.finding_id,
        ordinal: row.ordinal!,
        disposition: row.disposition,
      })
    }
    reviews.set(row.review_record_id, review)
  }
  return [...reviews.values()]
}
