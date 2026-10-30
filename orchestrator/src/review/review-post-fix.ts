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
import { reviewLineage } from './review-lineage-store.ts'
import { git, measureChangeIdentity, pinRef } from './review-pins.ts'
import { type ReviewRole, reviewCountsAsRound } from './review-role.ts'
import { reviewRoundIdentity } from './review-round-identity.ts'
import { diffNumstat } from './review-tier.ts'
import {
  type ReviewTier,
  type ReviewTierFile,
  tierThreeRiskPaths,
} from './review-tier-classifier.ts'
import type { ReviewRoundEvidenceRow } from './review-yield.ts'

const POST_FIX_RELENS_TIER: ReviewTier['tier'] = 3

export type CompletedReview = {
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
      comparisonError?: string
    }

export type PostFixReviewDecision =
  | { kind: 'no-completed-round' }
  | { kind: 'reviewed-tip-unidentified'; reviewNumber: number }
  | {
      kind: 'comparison-failed'
      reviewNumber: number
      reviewedTip: string
      error: string
      fixPaths: string[]
      tierThreePaths: string[]
      applicability: ApplicableReview
    }
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
      fixPaths: string[]
      tierThreePaths: string[]
      applicability: ApplicableReview
    }

export type PerPathPatch = ReviewTierFile & { patchId: string }

export function mapPatchPaths(
  patches: PerPathPatch[],
  renamedPaths: ReadonlyMap<string, string>,
): PerPathPatch[] {
  return patches.map((patch) => ({
    ...patch,
    path: renamedPaths.get(patch.path) ?? patch.path,
  }))
}

type CompletedReviewEvidenceRow = Pick<
  ReviewRoundEvidenceRow,
  'review_record_id' | 'run_id' | 'launch_key' | 'branch' | 'patch_id' | 'path_set'
> & { review_number: number; role: ReviewRole }

export function latestCompletedReview(
  database: Database,
  project: string,
  branch: string,
): CompletedReview | null {
  const lineage = reviewLineage(database, project, branch)
  const rows = database
    .query<CompletedReviewEvidenceRow, [string, ...string[]]>(
      `SELECT r.record_id AS review_record_id,r.number AS review_number,r.role,
              run.record_id AS run_id,run.launch_key,run.branch,r.patch_id,r.path_set
         FROM review r
         JOIN review_lens rl ON rl.review_record_id=r.record_id
         JOIN run ON run.record_id=rl.run_record_id
        WHERE run.project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND run.branch IN (${lineage.map(() => '?').join(',')})
          AND ${completedReviewEvidenceSql('r', 'run', 'rl')}
        ORDER BY r.number DESC,rl.record_id`,
    )
    .all(project, ...lineage)
  const roundRows = rows.reduce<CompletedReviewEvidenceRow[]>((selected, row) => {
    if (selected.length > 0) return selected
    const candidate = rows.filter(
      ({ review_record_id }) => review_record_id === row.review_record_id,
    )
    return reviewCountsAsRound(row.role) ? candidate : selected
  }, [])
  const first = roundRows[0]
  if (!first) return null
  return {
    number: first.review_number,
    identity: reviewRoundIdentity(first).identity,
    launchKey: first.launch_key,
    runIds: roundRows.map(({ run_id }) => run_id),
  }
}

function recordedReviewedTip(repo: string, to: string, review: CompletedReview): string | null {
  let recorded: string | null = null
  for (const runId of review.runIds) {
    const commit = git(repo, ['rev-parse', '--verify', `${pinRef(runId)}^{commit}`])
    if (!commit.ok) continue
    recorded ??= commit.out
    if (git(repo, ['merge-base', '--is-ancestor', commit.out, to]).ok) return commit.out
  }
  return recorded
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

/** Compare two branch changes without depending on how either change was committed. */
export function fixFilesFromPatches(
  reviewed: PerPathPatch[],
  current: PerPathPatch[],
  trunkChangedPaths: readonly string[] = [],
): ReviewTierFile[] {
  const reviewedByPath = new Map(reviewed.map((file) => [file.path, file]))
  const currentByPath = new Map(current.map((file) => [file.path, file]))
  const overlapped = new Set(trunkChangedPaths)
  const paths = new Set([...reviewedByPath.keys(), ...currentByPath.keys()])
  return [...paths].sort().flatMap((path) => {
    const before = reviewedByPath.get(path)
    const after = currentByPath.get(path)
    if (before?.patchId === after?.patchId && !overlapped.has(path)) return []
    const source = after ?? before
    return source ? [{ path, insertions: source.insertions, deletions: source.deletions }] : []
  })
}

/** Hash a single diff section by its content and metadata, independent of path and hunk offsets. */
export function pathNeutralContentIdentity(section: string): string {
  let header = true
  const normalized = section
    .split('\n')
    .flatMap((line) => {
      if (line.startsWith('@@')) {
        header = false
        return ['@@']
      }
      if (line === 'GIT binary patch') {
        header = false
        return [line]
      }
      if (line.startsWith('Binary files ')) {
        header = false
        return ['Binary files differ']
      }
      if (
        header &&
        (line.startsWith('diff --git ') ||
          line.startsWith('index ') ||
          line.startsWith('--- ') ||
          line.startsWith('+++ ') ||
          line.startsWith('rename from ') ||
          line.startsWith('rename to ') ||
          line.startsWith('copy from ') ||
          line.startsWith('copy to '))
      ) {
        return []
      }
      return [line]
    })
    .join('\n')
  return new Bun.CryptoHasher('sha256').update(normalized).digest('hex')
}

function diffSections(diff: string): string[] {
  return diff ? diff.split(/(?=^diff --git )/m).filter(Boolean) : []
}

function changePatches(
  repo: string,
  tip: string,
  trunkRef: string,
): { mergeBase: string; patches: PerPathPatch[] } {
  const mergeBase = git(repo, ['merge-base', tip, trunkRef])
  if (!mergeBase.ok) throw new Error(mergeBase.err)
  const files = diffNumstat(repo, mergeBase.out, tip)
  const diff = git(repo, [
    'diff',
    '--binary',
    '--no-ext-diff',
    '--no-color',
    '--no-renames',
    '--unified=0',
    `${mergeBase.out}..${tip}`,
  ])
  if (!diff.ok) throw new Error(diff.err)
  const sections = diffSections(new TextDecoder().decode(diff.stdout))
  if (sections.length !== files.length) {
    throw new Error(
      `git diff section count ${sections.length} did not match numstat count ${files.length}`,
    )
  }
  const patches = files.map((file, index) => ({
    ...file,
    patchId: pathNeutralContentIdentity(sections[index]!),
  }))
  return { mergeBase: mergeBase.out, patches }
}

function trunkChange(
  repo: string,
  reviewedBase: string,
  currentBase: string,
): { changedPaths: string[]; renames: Map<string, string> } {
  const result = git(repo, [
    'diff',
    '--name-status',
    '--find-renames',
    '-z',
    `${reviewedBase}..${currentBase}`,
  ])
  if (!result.ok) throw new Error(result.err)
  const fields = result.out.split('\0').filter(Boolean)
  const renames = new Map<string, string>()
  const changedPaths: string[] = []
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++]!
    const path = fields[index++]
    if (!path) throw new Error('git diff --name-status omitted a changed path')
    if (status.startsWith('R')) {
      const renamedPath = fields[index++]
      if (!renamedPath) throw new Error('git diff --name-status omitted a renamed path')
      renames.set(path, renamedPath)
      changedPaths.push(renamedPath)
    } else {
      changedPaths.push(path)
    }
  }
  return { changedPaths, renames }
}

function branchFixFiles(
  repo: string,
  reviewedTip: string,
  currentTip: string,
  trunkRef: string,
): ReviewTierFile[] {
  const reviewed = changePatches(repo, reviewedTip, trunkRef)
  const current = changePatches(repo, currentTip, trunkRef)
  const rebased = !git(repo, ['merge-base', '--is-ancestor', reviewedTip, currentTip]).ok
  const trunk = trunkChange(repo, reviewed.mergeBase, current.mergeBase)
  return fixFilesFromPatches(
    mapPatchPaths(reviewed.patches, trunk.renames),
    current.patches,
    rebased ? trunk.changedPaths : [],
  )
}

function currentChangeFiles(repo: string, currentTip: string, trunkRef: string): ReviewTierFile[] {
  const mergeBase = git(repo, ['merge-base', currentTip, trunkRef])
  if (!mergeBase.ok) throw new Error(mergeBase.err)
  return diffNumstat(repo, mergeBase.out, currentTip)
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
  } catch (cause) {
    const comparisonError = String((cause as Error)?.message ?? cause)
    let fixFiles: ReviewTierFile[] = []
    try {
      fixFiles = currentChangeFiles(input.repo, input.to, input.trunkRef)
    } catch (fallbackCause) {
      const fallbackError = String((fallbackCause as Error)?.message ?? fallbackCause)
      return {
        completed,
        reviewedTip,
        fixFiles,
        comparisonError: `${comparisonError}; current change paths also failed: ${fallbackError}`,
      }
    }
    return { completed, reviewedTip, fixFiles, comparisonError }
  }
}

/** Decide post-fix review applicability from already-gathered facts. */
export function postFixReviewDecision(input: {
  facts: PostFixReviewFacts
  tier: ReviewTier['tier']
  review: ReviewSettings | undefined
}): PostFixReviewDecision {
  if (!input.facts.completed) return { kind: 'no-completed-round' }
  const { completed, reviewedTip, fixFiles, comparisonError } = input.facts
  if (reviewedTip && fixFiles && comparisonError) {
    const tierThreePaths =
      input.tier === POST_FIX_RELENS_TIER ? tierThreeRiskPaths(fixFiles, input.review?.risk) : []
    return {
      kind: 'comparison-failed',
      reviewNumber: completed.number,
      reviewedTip,
      error: comparisonError,
      fixPaths: fixFiles.map(({ path }) => path),
      tierThreePaths,
      applicability:
        tierThreePaths.length > 0
          ? applicablePostFixReview(
              POST_FIX_RELENS_TIER,
              fixFiles.map(({ path }) => path),
              input.review,
            )
          : applicableReview(0, [], input.review),
    }
  }
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
    fixPaths: fixFiles.map(({ path }) => path),
    tierThreePaths,
    applicability: applicablePostFixReview(
      POST_FIX_RELENS_TIER,
      fixFiles.map(({ path }) => path),
      input.review,
    ),
  }
}
