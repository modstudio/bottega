// concern: review-post-fix
/** Finds a completed round's reviewed tip and decides whether its fix needs a narrow re-lens. */

import type { Database } from 'bun:sqlite'
import {
  nulPathListArgs,
  splitNulNameStatus,
  splitNulPaths,
} from '../../../shared/git-path-list.ts'
import type { ReviewSettings } from '../project/project-injection.ts'
import {
  type ApplicableReview,
  applicablePostFixReview,
  applicableReview,
  selectReviewApplicability,
} from './review-applicability.ts'
import { filesCoveredIncludesPath } from './review-coverage-match.ts'
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
  pathsByLens: Readonly<Record<string, readonly string[]>>
}

export type PostFixReviewFacts =
  | { completed: null }
  | {
      completed: CompletedReview
      reviewedTip: string | null
      fixFiles: ReviewTierFile[] | null
      reOwedPathsByLens?: Readonly<Record<string, readonly string[]>>
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
      reOwedPathsByLens?: Readonly<Record<string, readonly string[]>>
    }

export type PerPathPatch = ReviewTierFile & { patchId: string }

export type RebaseFileComparison = {
  path: string
  replayed: PerPathPatch | null
  current: PerPathPatch | null
  conflicted: boolean
}

export type RebaseCarryDecision = {
  fixFiles: ReviewTierFile[]
  reOwedPathsByLens: Readonly<Record<string, readonly string[]>>
}

/** Decide review carry from per-file replay facts and recorded lens coverage. */
export function rebaseCarryDecision(input: {
  files: readonly RebaseFileComparison[]
  pathsByLens: Readonly<Record<string, readonly string[]>>
}): RebaseCarryDecision {
  const changed = input.files.filter(
    ({ replayed, current, conflicted }) => conflicted || replayed?.patchId !== current?.patchId,
  )
  const fixFiles = changed.map(({ path, replayed, current }) => {
    const source = current ?? replayed
    return {
      path,
      insertions: source?.insertions ?? 0,
      deletions: source?.deletions ?? 0,
    }
  })
  const changedPaths = fixFiles.map(({ path }) => path)
  const reOwedPathsByLens = Object.fromEntries(
    Object.entries(input.pathsByLens).flatMap(([lens, covered]) => {
      const paths = changedPaths.filter((path) => filesCoveredIncludesPath(path, covered))
      return paths.length ? [[lens, paths] as const] : []
    }),
  )
  return { fixFiles, reOwedPathsByLens }
}

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
> & {
  review_number: number
  role: ReviewRole
  lens: string
  files_covered: string
}

export function latestCompletedReview(
  database: Database,
  project: string,
  branch: string,
): CompletedReview | null {
  const lineage = reviewLineage(database, project, branch)
  const rows = database
    .query<CompletedReviewEvidenceRow, [string, ...string[]]>(
      `SELECT r.record_id AS review_record_id,r.number AS review_number,r.role,
              run.record_id AS run_id,run.launch_key,run.branch,r.patch_id,r.path_set,
              rl.lens,rl.files_covered
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
  const pathsByLens: Record<string, string[]> = {}
  for (const row of roundRows) {
    const paths = JSON.parse(row.files_covered) as unknown
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) {
      throw new Error(`review lens ${row.lens} files_covered is not a JSON array of paths`)
    }
    pathsByLens[row.lens] = [...new Set([...(pathsByLens[row.lens] ?? []), ...paths])]
  }
  return {
    number: first.review_number,
    identity: reviewRoundIdentity(first).identity,
    launchKey: first.launch_key,
    runIds: roundRows.map(({ run_id }) => run_id),
    pathsByLens,
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

type ReviewedTipMatch = {
  reviewedTip: string
  rebaseCarry?: RebaseCarryDecision
}

function matchingReviewedTip(
  repo: string,
  to: string,
  trunkRef: string,
  branch: string,
  review: CompletedReview,
): ReviewedTipMatch | null {
  const recorded = recordedReviewedTip(repo, to, review)
  if (recorded) {
    if (git(repo, ['merge-base', '--is-ancestor', recorded, to]).ok) {
      return { reviewedTip: recorded }
    }
    return {
      reviewedTip: recorded,
      rebaseCarry: compareReplayedReview(repo, recorded, to, trunkRef, review.pathsByLens),
    }
  }
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
  return match ? { reviewedTip: match } : null
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
  return { mergeBase: mergeBase.out, patches: patchesForRange(repo, mergeBase.out, tip) }
}

function patchesForRange(repo: string, base: string, tip: string): PerPathPatch[] {
  const files = diffNumstat(repo, base, tip)
  const diff = git(repo, [
    'diff',
    '--binary',
    '--no-ext-diff',
    '--no-color',
    '--no-renames',
    '--unified=0',
    `${base}..${tip}`,
  ])
  if (!diff.ok) throw new Error(diff.err)
  const sections = diffSections(new TextDecoder().decode(diff.stdout))
  if (sections.length !== files.length) {
    throw new Error(
      `git diff section count ${sections.length} did not match numstat count ${files.length}`,
    )
  }
  return files.map((file, index) => ({
    ...file,
    patchId: pathNeutralContentIdentity(sections[index]!),
  }))
}

function mergeTreeReplay(input: {
  repo: string
  reviewedBase: string
  currentBase: string
  reviewedTip: string
}): { tree: string; conflictedPaths: string[] } {
  const replay = git(
    input.repo,
    nulPathListArgs([
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      '-z',
      `--merge-base=${input.reviewedBase}`,
      input.currentBase,
      input.reviewedTip,
    ]),
  )
  const [tree = '', ...conflictedPaths] = splitNulPaths(new TextDecoder().decode(replay.stdout))
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error(replay.err)
  return { tree, conflictedPaths }
}

function compareReplayedReview(
  repo: string,
  reviewedTip: string,
  currentTip: string,
  trunkRef: string,
  pathsByLens: Readonly<Record<string, readonly string[]>>,
): RebaseCarryDecision {
  const reviewedBase = git(repo, ['merge-base', reviewedTip, trunkRef])
  if (!reviewedBase.ok) throw new Error(reviewedBase.err)
  const currentBase = git(repo, ['merge-base', currentTip, trunkRef])
  if (!currentBase.ok) throw new Error(currentBase.err)
  const replay = mergeTreeReplay({
    repo,
    reviewedBase: reviewedBase.out,
    currentBase: currentBase.out,
    reviewedTip,
  })
  const replayed = patchesForRange(repo, currentBase.out, replay.tree)
  const current = patchesForRange(repo, currentBase.out, currentTip)
  const replayedByPath = new Map(replayed.map((file) => [file.path, file]))
  const currentByPath = new Map(current.map((file) => [file.path, file]))
  const paths = [...new Set([...replayedByPath.keys(), ...currentByPath.keys()])].sort()
  const conflicts = new Set(replay.conflictedPaths)
  return rebaseCarryDecision({
    files: paths.map((path) => ({
      path,
      replayed: replayedByPath.get(path) ?? null,
      current: currentByPath.get(path) ?? null,
      conflicted: conflicts.has(path),
    })),
    pathsByLens,
  })
}

function trunkChange(
  repo: string,
  reviewedBase: string,
  currentBase: string,
): { changedPaths: string[]; renames: Map<string, string> } {
  const result = git(
    repo,
    nulPathListArgs(['diff', '--name-status', '--find-renames', `${reviewedBase}..${currentBase}`]),
  )
  if (!result.ok) throw new Error(result.err)
  const renames = new Map<string, string>()
  const changedPaths: string[] = []
  for (const { status, path, previousPath } of splitNulNameStatus(result.out)) {
    if (status.startsWith('R') && previousPath !== null) renames.set(previousPath, path)
    changedPaths.push(path)
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
  let match: ReviewedTipMatch | null = null
  try {
    match = matchingReviewedTip(input.repo, input.to, input.trunkRef, input.branch, completed)
    if (!match) return { completed, reviewedTip: null, fixFiles: null }
    if (match.rebaseCarry) {
      return {
        completed,
        reviewedTip: match.reviewedTip,
        fixFiles: match.rebaseCarry.fixFiles,
        reOwedPathsByLens: match.rebaseCarry.reOwedPathsByLens,
      }
    }
    return {
      completed,
      reviewedTip: match.reviewedTip,
      fixFiles: branchFixFiles(input.repo, match.reviewedTip, input.to, input.trunkRef),
    }
  } catch (cause) {
    const comparisonError = String((cause as Error)?.message ?? cause)
    const reviewedTip = match?.reviewedTip ?? recordedReviewedTip(input.repo, input.to, completed)
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
  const { completed, reviewedTip, fixFiles, comparisonError, reOwedPathsByLens } = input.facts
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
  const reOwedLenses = Object.keys(reOwedPathsByLens ?? {})
  if (tierThreePaths.length === 0 && reOwedLenses.length === 0) {
    return {
      kind: 'no-round-needed',
      reviewNumber: completed.number,
      reviewedTip,
      tierThreePaths: [],
      applicability: applicableReview(0, [], input.review),
    }
  }
  const applicable = applicablePostFixReview(
    POST_FIX_RELENS_TIER,
    fixFiles.map(({ path }) => path),
    input.review,
  )
  // A tier-3 fix path owes the ordinary selection; a rebase owes only the lenses that read a changed file.
  const ordinaryLenses = tierThreePaths.length > 0 ? applicable.lenses : []
  return {
    kind: 're-lens',
    reviewNumber: completed.number,
    reviewedTip,
    fixPaths: fixFiles.map(({ path }) => path),
    tierThreePaths,
    applicability: selectReviewApplicability(applicable, [
      ...new Set([...ordinaryLenses, ...reOwedLenses]),
    ]),
    ...(reOwedPathsByLens ? { reOwedPathsByLens } : {}),
  }
}
