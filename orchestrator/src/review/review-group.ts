// concern: review-group
/** Measures change groups and reads their recorded review rows. */

import type { Database } from 'bun:sqlite'
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Project } from '../project/projects.ts'
import {
  type ApplicableReview,
  applicableReviewForChange,
  type ReviewPlan,
} from './review-applicability.ts'
import type { LensProvenanceSubjectFacts } from './review-lens-provenance.ts'
import { reviewLineage } from './review-lineage-store.ts'
import { measureChangeIdentity } from './review-pins.ts'
import type { ReviewRole } from './review-role.ts'
import { resolveReviewBase } from './review-target.ts'
import { diffNumstat } from './review-tier.ts'
import type { ReviewTier } from './review-tier-classifier.ts'

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
  role: ReviewRole
  patchId: string | null
  pathSet: string | null
  lensIdentities: readonly string[]
  lenses: readonly {
    recordId: string
    runId?: string
    lens?: string
    model?: string | null
    graded: boolean
    settled: boolean
    provenance?: LensProvenanceSubjectFacts
    taskTextInput?: string | null
    rulingsInput?: string | null
  }[]
  findings: readonly {
    recordId: string
    ordinal: number
    disposition: string | null
    lens?: string
  }[]
}

type StoredReviewProvenance = {
  tree_inspected?: unknown
  reviewed_commit?: unknown
}

const provenanceString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null

const treePathToken = /(?:^|[\s`(])(\/[^\s()`'",;]+)/g

/** The first absolute path claim in a lens's free-text tree evidence. */
export function treeInspectedPath(treeInspected: string | null | undefined): string | null {
  if (!treeInspected) return null
  for (const match of treeInspected.matchAll(treePathToken)) {
    const candidate = match[1]?.replace(/[.:]+$/, '')
    if (candidate && candidate.split('/').filter(Boolean).length >= 3) return candidate
  }
  return null
}

/** Resolve both existing trees physically, or both missing-tree identities lexically. */
export function canonicalTreePair(treeInspected: string, runTree: string): [string, string] {
  if (existsSync(treeInspected) && existsSync(runTree)) {
    return [realpathSync(treeInspected), realpathSync(runTree)]
  }
  return [resolve(treeInspected), resolve(runTree)]
}

export function provenanceSubjectFacts(row: {
  review_provenance: string | null
  worktree: string | null
  cwd: string | null
  head_commit: string | null
}): LensProvenanceSubjectFacts {
  if (row.review_provenance === null) {
    return {
      recorded: false,
      treeInspected: null,
      runTree: null,
      reviewedCommit: null,
      headCommit: row.head_commit,
    }
  }
  let provenance: StoredReviewProvenance = {}
  try {
    provenance = JSON.parse(row.review_provenance) as StoredReviewProvenance
  } catch {
    // A malformed recorded provenance cannot establish either subject claim.
  }
  const treeInspected = treeInspectedPath(provenanceString(provenance.tree_inspected))
  const runTree = row.worktree ?? row.cwd
  const [canonicalInspected, canonicalRun] =
    treeInspected && runTree ? canonicalTreePair(treeInspected, runTree) : [treeInspected, runTree]
  return {
    recorded: true,
    treeInspected: canonicalInspected,
    runTree: canonicalRun,
    reviewedCommit: provenanceString(provenance.reviewed_commit),
    headCommit: row.head_commit,
  }
}

type StoredTriageReviewRow = {
  review_record_id: string
  review_number: number
  recorded_at: string
  completed_at: string | null
  tier: 0 | 1 | 2 | 3 | null
  role: ReviewRole
  patch_id: string | null
  path_set: string | null
  lens_id: string
  run_record_id: string
  lens: string
  model: string | null
  delivery: string | null
  reproduced: string | null
  coverage: string | null
  limits: string | null
  overlap: string | null
  task_text_input: string | null
  rulings_input: string | null
  review_provenance: string | null
  worktree: string | null
  cwd: string | null
  head_commit: string | null
  finding_id: string | null
  ordinal: number | null
  disposition: string | null
}

export function reviewLensGraded(lens: {
  reproduced: string | null
  coverage: string | null
  limits: string | null
  overlap: string | null
}): boolean {
  return (
    lens.reproduced !== null &&
    lens.coverage !== null &&
    lens.limits !== null &&
    lens.overlap !== null
  )
}

/** Whether this lens needs anything more from the architect before round triage. */
export function reviewLensSettled(lens: {
  delivery: string | null
  reproduced: string | null
  coverage: string | null
  limits: string | null
  overlap: string | null
}): boolean {
  return lens.delivery === 'none' || reviewLensGraded(lens)
}

/** The triage floor shared by workflow evidence and project review recording. */
export function reviewRoundTriageComplete(review: TriageReviewRow): boolean {
  return (
    review.lenses.length > 0 &&
    review.lenses.every(({ settled }) => settled) &&
    review.findings.every(({ disposition }) => disposition !== null)
  )
}

export type MeasuredChangeGroup = {
  group: ChangeGroup
  base: string
  tier: ReviewTier
  applicability: ApplicableReview
  message: string
}

export type MeasuredReviewChange = {
  patchId: string
  pathSet: string[]
  base: string
  tier: ReviewTier
  applicability: ApplicableReview
  message: string
}

type ChangeGroupOperations = {
  mergeBase(cwd: string, tip: string, trunk: string): string | null
  identity(
    cwd: string,
    base: string,
    tip: string,
  ): { patchId: string; paths: string[]; message: string } | null
  reviewPlan(
    cwd: string,
    base: string,
    tip: string,
    review: Project['settings']['review'],
  ): ReviewPlan
}

const changeGroupOperations: ChangeGroupOperations = {
  mergeBase: resolveReviewBase,
  identity: measureChangeIdentity,
  reviewPlan: (cwd, base, tip, review) =>
    applicableReviewForChange(diffNumstat(cwd, base, tip), review),
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
  const plan = operations.reviewPlan(cwd, base, tip, project.settings.review)
  return {
    patchId: identity.patchId,
    pathSet: identity.paths,
    base,
    tier: plan.tier,
    applicability: plan.applicability,
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
    applicability: measured.applicability,
    message: measured.message,
  }
}

/** A review belongs to a round when it measured that exact patch and path set. */
export function reviewInRound(review: TriageReviewRow, patchId: string, pathSet: string): boolean {
  return review.patchId === patchId && review.pathSet === pathSet
}

function reviewsForChangeGroup(
  branchReviews: readonly TriageReviewRow[],
  group: ChangeGroup,
): TriageReviewRow[] {
  const pathSet = serializePathSet(group.pathSet)
  return branchReviews.filter((review) => reviewInRound(review, group.patchId, pathSet))
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

/** Task attributed to the branch's most recent run or minting run. */
export function reviewTaskKeyForBranch(
  database: Database,
  project: string,
  branch: string,
): string | null {
  const row = database
    .query<{ launch_key: string }, [string, string]>(
      `SELECT launch_key FROM run
        WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND branch=? AND launch_key IS NOT NULL AND trim(launch_key)<>''
        ORDER BY number DESC LIMIT 1`,
    )
    .get(project, branch)
  return row?.launch_key.trim().toUpperCase() ?? null
}

/** Admission candidates from lineage plus exact same-task change evidence on any branch. */
export function reviewsForAdmission(
  database: Database,
  group: ChangeGroup,
): { reviews: TriageReviewRow[]; branchReviews: TriageReviewRow[] } {
  const branchReviews = reviewsForBranch(database, group.project, group.branch)
  const taskKey = reviewTaskKeyForBranch(database, group.project, group.branch)
  if (!taskKey) return { branchReviews, reviews: reviewsForChangeGroup(branchReviews, group) }
  const exactReviewIds = database
    .query<{ record_id: string }, [string, string, string, string]>(
      `SELECT DISTINCT r.record_id FROM review r INDEXED BY review_project_patch
         JOIN review_lens rl ON rl.review_record_id=r.record_id
         JOIN run ON run.record_id=rl.run_record_id
        WHERE r.project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND r.patch_id=? AND r.path_set=? AND upper(trim(run.launch_key))=?`,
    )
    .all(group.project, group.patchId, serializePathSet(group.pathSet), taskKey.toUpperCase())
    .map(({ record_id }) => record_id)
  const candidates = reviewsForBranch(
    database,
    group.project,
    group.branch,
    undefined,
    exactReviewIds,
  )
  return { branchReviews, reviews: reviewsForChangeGroup(candidates, group) }
}

/** All review rounds recorded by runs on a branch, newest first. */
function reviewsForBranch(
  database: Database,
  project: string,
  branch: string,
  includeReviewId?: string,
  includeReviewIds: readonly string[] = [],
): TriageReviewRow[] {
  const lineage = reviewLineage(database, project, branch)
  const rows = database
    .query<StoredTriageReviewRow, (string | null)[]>(
      `SELECT r.record_id review_record_id,r.number review_number,r.recorded_at,r.completed_at,r.tier,r.role,r.patch_id,r.path_set,
              rl.record_id lens_id,rl.run_record_id,rl.lens,rl.model,s.delivery,rl.reproduced,rl.coverage,rl.limits,rl.overlap,
              rl.task_text_input,rl.rulings_input,
              run.review_provenance,run.worktree,run.cwd,run.head_commit,
              rf.record_id finding_id,rf.ordinal,rf.disposition
         FROM review r JOIN review_lens rl ON rl.review_record_id=r.record_id
         JOIN run ON run.record_id=rl.run_record_id
         LEFT JOIN score s ON s.run_record_id=run.record_id
         LEFT JOIN review_finding rf ON rf.review_lens_record_id=rl.record_id
        WHERE run.project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND (run.branch IN (${lineage.map(() => '?').join(',')}) OR r.record_id=?
               OR r.record_id IN (${includeReviewIds.map(() => '?').join(',') || 'NULL'}))
        ORDER BY r.number DESC,rl.record_id DESC,rf.ordinal`,
    )
    .all(project, ...lineage, includeReviewId ?? null, ...includeReviewIds)
  const reviews = new Map<string, TriageReviewRow>()
  for (const row of rows) {
    const review = reviews.get(row.review_record_id) ?? {
      reviewRecordId: row.review_record_id,
      reviewNumber: row.review_number,
      recordedAt: row.recorded_at,
      completedAt: row.completed_at,
      tier: row.tier,
      role: row.role,
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
          settled: boolean
          provenance: LensProvenanceSubjectFacts
          taskTextInput: string | null
          rulingsInput: string | null
        }[]
      ).push({
        recordId: row.lens_id,
        runId: row.run_record_id,
        lens: row.lens,
        model: row.model,
        graded: reviewLensGraded(row),
        settled: reviewLensSettled(row),
        provenance: provenanceSubjectFacts(row),
        taskTextInput: row.task_text_input,
        rulingsInput: row.rulings_input,
      })
    }
    if (
      row.finding_id !== null &&
      !review.findings.some((finding) => finding.recordId === row.finding_id)
    ) {
      ;(
        review.findings as {
          recordId: string
          ordinal: number
          disposition: string | null
          lens?: string
        }[]
      ).push({
        recordId: row.finding_id,
        ordinal: row.ordinal!,
        disposition: row.disposition,
        lens: row.lens,
      })
    }
    reviews.set(row.review_record_id, review)
  }
  return [...reviews.values()]
}
