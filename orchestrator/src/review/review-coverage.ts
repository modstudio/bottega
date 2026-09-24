// concern: review-coverage
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { changeIdentity } from './change-identity.ts'
import { git, reviewGit, targetGitEnvironment } from './review-pins.ts'
import { reviewTrunkRef } from './review-target.ts'
import type {
  CoverageGitResult,
  CoverageGitRunner,
  CoverageVerdict,
  ReviewCoverageInput,
  ReviewListRow,
} from './review-types.ts'

function coverageGit(repoRoot: string): CoverageGitRunner {
  return (args, stdin) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd: repoRoot,
      env: targetGitEnvironment(repoRoot),
      stdin,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return {
      ok: p.exitCode === 0,
      out: p.stdout.toString().trim(),
      stdout: p.stdout,
      err: p.stderr.toString().trim() || `exit ${p.exitCode}`,
    }
  }
}

function coverageOutput(result: CoverageGitResult, args: string[]): string {
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.err}`)
  return result.out
}

function commitsFrom(runner: CoverageGitRunner, args: string[]): string[] {
  const result = runner(args)
  return result.ok && result.out ? result.out.split('\n') : []
}

function commitForTree(
  runner: CoverageGitRunner,
  review: ReviewCoverageInput,
  tree: string,
): { commit: string | null; resolution: 'pin' | 'walk' } {
  const pinned = review.lenses.filter((lens) => lens.headCommit !== null)
  if (pinned.length) {
    const commits = new Set(pinned.map((lens) => lens.headCommit!))
    if (commits.size === 1) {
      const commit = pinned[0]!.headCommit!
      if (runner(['cat-file', '-e', `${commit}^{commit}`]).ok) {
        const args = ['rev-parse', `${commit}^{tree}`]
        if (coverageOutput(runner(args), args) === tree) {
          return { commit, resolution: 'pin' }
        }
      }
    }
    if (pinned.length === review.lenses.length) {
      return { commit: null, resolution: 'pin' }
    }
  }
  const branches = [
    ...new Set(
      review.lenses
        .filter((lens) => lens.inputTree === tree)
        .map((lens) => lens.branch)
        .filter((branch): branch is string => Boolean(branch)),
    ),
  ]
  const seen = new Set<string>()
  const candidates = branches.flatMap((branch) =>
    commitsFrom(runner, ['rev-list', '--walk-reflogs', '--max-count=50', branch]),
  )
  for (const commit of candidates) {
    seen.add(commit)
    const args = ['rev-parse', `${commit}^{tree}`]
    if (coverageOutput(runner(args), args) === tree) return { commit, resolution: 'walk' }
  }
  for (const commit of commitsFrom(runner, ['log', '--all', '--format=%H', '--max-count=500'])) {
    if (seen.has(commit)) continue
    const args = ['rev-parse', `${commit}^{tree}`]
    if (coverageOutput(runner(args), args) === tree) return { commit, resolution: 'walk' }
  }
  return { commit: null, resolution: 'walk' }
}

function changedPaths(runner: CoverageGitRunner, from: string, to: string): Set<string> {
  const args = ['diff', '--name-only', `${from}..${to}`]
  const output = coverageOutput(runner(args), args)
  return new Set(output ? output.split('\n') : [])
}

export function reviewCoverageVerdict(
  repoRoot: string,
  review: ReviewCoverageInput,
  tip: string,
  trunk: string,
  runner: CoverageGitRunner = coverageGit(repoRoot),
  opts?: { skipExact?: boolean },
): CoverageVerdict {
  const treeArgs = ['rev-parse', `${tip}^{tree}`]
  const treeResult = runner(treeArgs)
  if (!treeResult.ok)
    return { kind: 'invalid', reason: `git ${treeArgs.join(' ')} failed: ${treeResult.err}` }
  const tree = treeResult.out
  if (
    !opts?.skipExact &&
    review.lenses.length > 0 &&
    review.lenses.every((lens) => lens.tree === tree) &&
    review.lenses.every(
      (lens) =>
        lens.headCommit !== null && runner(['cat-file', '-e', `${lens.headCommit}^{commit}`]).ok,
    )
  ) {
    return { kind: 'exact' }
  }
  const reviewedTree = review.lenses[0]?.tree
  if (!reviewedTree || !review.lenses.every((lens) => lens.tree === reviewedTree)) {
    return { kind: 'invalid', reason: 'review lenses do not agree on one tree' }
  }
  if (
    !review.lenses.every(
      (lens) => lens.inputTree === reviewedTree && lens.branch !== null && lens.baseCommit !== null,
    )
  ) {
    return { kind: 'invalid', reason: 'lens metadata incomplete' }
  }
  const bases = new Set(review.lenses.map((lens) => lens.baseCommit))
  if (bases.size !== 1) return { kind: 'invalid', reason: 'lens bases disagree' }
  const resolved = commitForTree(runner, review, reviewedTree)
  const reviewedCommit = resolved.commit
  if (!reviewedCommit) {
    return { kind: 'invalid', reason: 'reviewed commit not found', resolution: resolved.resolution }
  }
  const baseCommit = review.lenses[0]!.baseCommit!
  if (!runner(['cat-file', '-e', `${baseCommit}^{commit}`]).ok) {
    return { kind: 'invalid', reason: 'reviewed commit not found', resolution: resolved.resolution }
  }
  const oldBaseArgs = ['merge-base', reviewedCommit, baseCommit]
  const oldBaseResult = runner(oldBaseArgs)
  if (!oldBaseResult.ok) {
    return {
      kind: 'invalid',
      reason: `git ${oldBaseArgs.join(' ')} failed: ${oldBaseResult.err}`,
      resolution: resolved.resolution,
    }
  }
  const oldBase = oldBaseResult.out
  const remoteTrackingRefExists = runner([
    'show-ref',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${trunk}`,
  ]).ok
  const newBaseArgs = ['merge-base', tip, reviewTrunkRef(remoteTrackingRefExists, trunk)]
  const newBaseDisplayArgs = ['merge-base', tip, trunk]
  const newBaseResult = runner(newBaseArgs)
  if (!newBaseResult.ok) {
    return {
      kind: 'invalid',
      reason: `git ${newBaseDisplayArgs.join(' ')} failed: ${newBaseResult.err}`,
      resolution: resolved.resolution,
    }
  }
  const newBase = newBaseResult.out
  const changePaths = changedPaths(runner, oldBase, reviewedCommit)
  const reviewedPatch = review.patchId || changeIdentity(runner, oldBase, reviewedCommit)
  const candidatePatch = changeIdentity(runner, newBase, tip)
  if (!reviewedPatch || reviewedPatch !== candidatePatch) {
    return { kind: 'invalid', reason: 'patch-id differs', resolution: resolved.resolution }
  }
  const candidatePaths = [...changedPaths(runner, newBase, tip)].sort()
  const reviewedPaths = review.pathSet
    ? (JSON.parse(review.pathSet) as string[])
    : [...changePaths].sort()
  if (JSON.stringify(reviewedPaths) !== JSON.stringify(candidatePaths)) {
    return { kind: 'invalid', reason: 'path set differs', resolution: resolved.resolution }
  }
  const trunkPaths = changedPaths(runner, oldBase, newBase)
  const overlap = [...changePaths].filter((path) => trunkPaths.has(path))
  if (overlap.length) {
    return {
      kind: 'invalid',
      reason: `overlapping paths: ${overlap.sort().join(', ')}`,
      resolution: resolved.resolution,
    }
  }
  const messageResult = runner(['log', '--format=%B', `${newBase}..${tip}`])
  const message = messageResult.ok ? messageResult.out : ''
  return {
    kind: 'carried',
    class:
      review.commitMessage !== null &&
      review.commitMessage !== undefined &&
      review.commitMessage !== message
        ? 'no-code-change'
        : 'trivial-rebase',
    resolution: resolved.resolution,
    tip,
    tree,
    reviewId: review.id,
    reviewedCommit,
    reviewedTree,
    patchId: candidatePatch,
    oldBase,
    newBase,
  }
}

export function projectRecord(
  database: Database,
  name: string,
): { path: string; trunk: string } | null {
  const row = database.query('SELECT path, settings FROM project WHERE name=?').get(name) as {
    path: string
    settings: string
  } | null
  if (!row) return null
  let settings: Record<string, unknown> = {}
  try {
    settings = JSON.parse(row.settings)
  } catch {
    return null
  }
  return { path: row.path, trunk: typeof settings.trunk === 'string' ? settings.trunk.trim() : '' }
}

export function currentCoverage(
  review: ReviewCoverageInput,
  project: string | null,
  database: Database,
): ReviewListRow['coverage'] {
  if (!project) return null
  const registered = projectRecord(database, project)
  if (!registered?.trunk) return null
  const branches = [
    ...new Set(review.lenses.map((lens) => lens.branch).filter((x): x is string => Boolean(x))),
  ]
  if (!branches.length) return null
  const verdicts = branches.flatMap((branch) => {
    const ref = `refs/heads/${branch}`
    const runner = reviewGit(registered.path)
    const tip = runner(['rev-parse', '--verify', ref])
    if (!tip.ok) return [null]
    const verdict = reviewCoverageVerdict(
      registered.path,
      review,
      tip.out,
      registered.trunk,
      runner,
    )
    return [
      verdict.kind === 'invalid'
        ? ('stale' as const)
        : verdict.kind === 'carried'
          ? verdict.class
          : verdict.kind,
    ]
  })
  if (verdicts.includes(null)) return null
  if (verdicts.includes('stale')) return 'stale'
  return verdicts.includes('no-code-change')
    ? 'no-code-change'
    : verdicts.includes('trivial-rebase')
      ? 'trivial-rebase'
      : 'exact'
}

export type CoverageAudit = {
  count: number
  review_ids: number[]
  partial_review_ids: number[]
}

/** Find completed reviews whose lenses measured trunk at their own worktree cut. */
export function coverageAudit(database: Database = db()): CoverageAudit {
  const projects = database.query('SELECT name, path, settings FROM project').all() as {
    name: string
    path: string
    settings: string | null
  }[]
  const registered = new Map<string, { path: string; trunk: string | null }>()
  for (const project of projects) {
    let trunk: string | null = null
    try {
      const settings = JSON.parse(project.settings ?? '{}') as { trunk?: unknown }
      if (typeof settings.trunk === 'string' && settings.trunk.trim()) trunk = settings.trunk
    } catch {
      /* an unreadable project setting cannot identify trunk */
    }
    registered.set(project.name, { path: project.path, trunk })
  }
  const rows = database
    .query(
      `SELECT review.id, run.repo, run.started_at, run.base_commit, review_lens.reviewed_tree
       FROM review
       JOIN review_lens ON review_lens.review_id=review.id
       JOIN run ON run.id=review_lens.run_id
      WHERE review.completed_at IS NOT NULL AND run.review_ref IS NULL
      ORDER BY review.id, review_lens.id`,
    )
    .all() as {
    id: number
    repo: string | null
    started_at: string
    base_commit: string | null
    reviewed_tree: string | null
  }[]
  const fallbackTrees = new Map<string, Set<string>>()
  const matches = new Map<number, boolean[]>()
  for (const row of rows) {
    const project = row.repo ? registered.get(row.repo) : null
    let expected: Set<string> | null = null
    if (project && row.base_commit) {
      const tree = git(project.path, ['rev-parse', '--verify', `${row.base_commit}^{tree}`])
      if (tree.ok) expected = new Set([tree.out])
    } else if (project?.trunk) {
      const cacheKey = `${row.repo}\0${row.started_at}`
      expected = fallbackTrees.get(cacheKey) ?? null
      if (!expected) {
        const history = git(project.path, [
          'log',
          '-n',
          '2000',
          '--format=%T',
          `--before=${row.started_at}`,
          project.trunk,
        ])
        expected = new Set(history.ok ? history.out.split('\n').filter(Boolean) : [])
        fallbackTrees.set(cacheKey, expected)
      }
    }
    const lensMatches = matches.get(row.id) ?? []
    lensMatches.push(Boolean(row.reviewed_tree && expected?.has(row.reviewed_tree)))
    matches.set(row.id, lensMatches)
  }
  const reviewIds: number[] = []
  const partialReviewIds: number[] = []
  for (const [reviewId, lensMatches] of matches) {
    if (lensMatches.length && lensMatches.every(Boolean)) reviewIds.push(reviewId)
    else if (lensMatches.some(Boolean)) partialReviewIds.push(reviewId)
  }
  return {
    count: reviewIds.length,
    review_ids: reviewIds,
    partial_review_ids: partialReviewIds,
  }
}
