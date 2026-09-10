import type { Database } from 'bun:sqlite'
import {
  db, nowIso, REVIEW_REPRODUCED, REVIEW_COVERAGE, REVIEW_LIMITS, REVIEW_OVERLAP,
  REVIEW_SEVERITY, sessionId,
  voidedSql,
  type ReviewReproduced, type ReviewCoverage, type ReviewLimits, type ReviewOverlap,
  type ReviewSeverity, writableDb, writeTransaction,
} from './db.ts'
import { CANON_SOURCE_SCHEMA, REVIEW_SCHEMA, type CanonSource, type ReviewReply } from './contract.ts'
import { job } from './jobs.ts'
import type { ReviewTier } from './review-tier.ts'
import { median } from './route.ts'
import { changeIdentity, type ChangeIdentityGitResult, type ChangeIdentityGitRunner } from './change-identity.ts'
import { projectByName, type Project } from './projects.ts'

const targetGitEnvironment = (repo: string) =>
  (require('./worktree.ts') as typeof import('./worktree.ts')).targetGitEnvironment(repo)
const classifyReviewTier: typeof import('./review-tier.ts').classifyReviewTier = (...args) =>
  (require('./review-tier.ts') as typeof import('./review-tier.ts')).classifyReviewTier(...args)
const diffNumstat: typeof import('./review-tier.ts').diffNumstat = (...args) =>
  (require('./review-tier.ts') as typeof import('./review-tier.ts')).diffNumstat(...args)

export const REVIEW_WINDOW = 50
/**
 * Initial safety floor. Re-set this from the observed triage distribution once
 * this repository has enough review data; until then the conservative value
 * prevents a handful of findings from changing reviewer behaviour.
 */
export const MIN_REVIEW_TRIAGED = 10

export const DISPOSITIONS = ['accepted', 'modified', 'rejected', 'skipped'] as const
export type Disposition = typeof DISPOSITIONS[number]

export type ReviewTriageBag = {
  total: number
  triaged: number
  untriaged: number
  accepted: number
  modified: number
  rejected: number
  skipped: number
  hits: number
}

export function reviewTriageBag(rows: readonly { disposition: string | null }[]): ReviewTriageBag {
  const count = (disposition: Disposition) =>
    rows.filter((row) => row.disposition === disposition).length
  const accepted = count('accepted')
  const modified = count('modified')
  const rejected = count('rejected')
  const skipped = count('skipped')
  return {
    total: rows.length,
    triaged: accepted + modified + rejected + skipped,
    untriaged: rows.filter((row) => row.disposition === null).length,
    accepted, modified, rejected, skipped,
    hits: accepted + modified,
  }
}

/** A recorded lens run eligible to become review evidence. */
export function reviewRunEvidenceSql(runAlias = 'run', lensAlias = 'rl'): string {
  return `NOT (${voidedSql(runAlias)})
    AND COALESCE(${runAlias}.probe, 0) = 0
    AND NOT EXISTS (SELECT 1 FROM score review_score
      WHERE review_score.run_id=${lensAlias}.run_id AND review_score.delivery='none')`
}

/** The complete-review boundary consumed by calibration and review reports. */
export function completedReviewEvidenceSql(
  reviewAlias = 'r', runAlias = 'run', lensAlias = 'rl',
): string {
  return `${reviewAlias}.completed_at IS NOT NULL
    AND ${reviewRunEvidenceSql(runAlias, lensAlias)}`
}

export type ReviewCoverageInput = {
  id: number
  patchId?: string | null
  pathSet?: string | null
  commitMessage?: string | null
  outdatedReason?: string | null
  lenses: {
    lens: string
    tree: string | null
    inputTree: string | null
    branch: string | null
    baseCommit: string | null
    launchCwd: string | null
    headCommit: string | null
  }[]
}

function completedReviews(project: string): ReviewCoverageInput[] {
  const rows = db().query(
    `SELECT r.id, r.patch_id, r.path_set, r.commit_message, r.outdated_reason,
            rl.lens, rl.reviewed_tree, run.input_tree,
            run.branch, run.base_commit, run.launch_cwd, run.head_commit
       FROM review r
       JOIN review_lens rl ON rl.review_id=r.id
       JOIN run ON run.id=rl.run_id
      WHERE ${completedReviewEvidenceSql('r', 'run', 'rl')} AND EXISTS (
        SELECT 1 FROM review_lens project_lens
        JOIN run project_run ON project_run.id=project_lens.run_id
        WHERE project_lens.review_id=r.id AND project_run.repo=?
      )
      ORDER BY r.id, rl.id`,
  ).all(project) as {
    id: number; patch_id: string | null; path_set: string | null; commit_message: string | null
    outdated_reason: string | null; lens: string; reviewed_tree: string | null
    input_tree: string | null; branch: string | null; base_commit: string | null
    launch_cwd: string | null; head_commit: string | null
  }[]
  const grouped = new Map<number, ReviewCoverageInput>()
  for (const row of rows) {
    const review = grouped.get(row.id) ?? { id: row.id, patchId: row.patch_id, pathSet: row.path_set,
      commitMessage: row.commit_message, outdatedReason: row.outdated_reason, lenses: [] }
    review.lenses.push({
      lens: row.lens, tree: row.reviewed_tree,
      inputTree: row.input_tree, branch: row.branch, baseCommit: row.base_commit,
      launchCwd: row.launch_cwd, headCommit: row.head_commit,
    })
    grouped.set(row.id, review)
  }
  return [...grouped.values()]
}

export type ReviewCarry = {
  project: string
  branch: string
  tip: string
  tree: string
  reviewId: number
  reviewedCommit: string
  reviewedTree: string
  patchId: string
  oldBase: string
  newBase: string
}

export type CoverageVerdict =
  | { kind: 'exact' }
  | ({ kind: 'carried'; class: 'trivial-rebase' | 'no-code-change'; resolution: 'pin' | 'walk' } & Omit<ReviewCarry, 'project' | 'branch'>)
  | { kind: 'invalid'; reason: string; resolution?: 'pin' | 'walk' }

export type CoverageGitResult = ChangeIdentityGitResult
export type CoverageGitRunner = ChangeIdentityGitRunner

function coverageGit(repoRoot: string): CoverageGitRunner {
  return (args, stdin) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd: repoRoot, env: targetGitEnvironment(repoRoot), stdin, stdout: 'pipe', stderr: 'pipe',
    })
    return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), stdout: p.stdout,
      err: p.stderr.toString().trim() || `exit ${p.exitCode}` }
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
  runner: CoverageGitRunner, review: ReviewCoverageInput, tree: string,
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
  const branches = [...new Set(review.lenses
    .filter((lens) => lens.inputTree === tree)
    .map((lens) => lens.branch)
    .filter((branch): branch is string => Boolean(branch)))]
  const seen = new Set<string>()
  const candidates = branches.flatMap((branch) =>
    commitsFrom(runner, ['rev-list', '--walk-reflogs', '--max-count=50', branch]))
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

function reviewBelongsToCandidate(review: ReviewCoverageInput, branch: string): boolean {
  return review.lenses.some((lens) => lens.branch === branch)
}

export function reviewCoverageVerdict(
  repoRoot: string, review: ReviewCoverageInput, tip: string, trunk: string,
  runner: CoverageGitRunner = coverageGit(repoRoot),
  opts?: { skipExact?: boolean },
): CoverageVerdict {
  const treeArgs = ['rev-parse', `${tip}^{tree}`]
  const treeResult = runner(treeArgs)
  if (!treeResult.ok) return { kind: 'invalid', reason: `git ${treeArgs.join(' ')} failed: ${treeResult.err}` }
  const tree = treeResult.out
  if (!opts?.skipExact && review.lenses.length > 0 &&
      review.lenses.every((lens) => lens.tree === tree) &&
      review.lenses.every((lens) => lens.headCommit !== null &&
        runner(['cat-file', '-e', `${lens.headCommit}^{commit}`]).ok)) {
    return { kind: 'exact' }
  }
  const reviewedTree = review.lenses[0]?.tree
  if (!reviewedTree || !review.lenses.every((lens) => lens.tree === reviewedTree)) {
    return { kind: 'invalid', reason: 'review lenses do not agree on one tree' }
  }
  if (!review.lenses.every((lens) =>
    lens.inputTree === reviewedTree && lens.branch !== null && lens.baseCommit !== null)) {
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
    return { kind: 'invalid', reason: `git ${oldBaseArgs.join(' ')} failed: ${oldBaseResult.err}`,
      resolution: resolved.resolution }
  }
  const oldBase = oldBaseResult.out
  const newBaseArgs = ['merge-base', tip, trunk]
  const newBaseResult = runner(newBaseArgs)
  if (!newBaseResult.ok) {
    return { kind: 'invalid', reason: `git ${newBaseArgs.join(' ')} failed: ${newBaseResult.err}`,
      resolution: resolved.resolution }
  }
  const newBase = newBaseResult.out
  const changePaths = changedPaths(runner, oldBase, reviewedCommit)
  const reviewedPatch = review.patchId || changeIdentity(runner, oldBase, reviewedCommit)
  const candidatePatch = changeIdentity(runner, newBase, tip)
  if (!reviewedPatch || reviewedPatch !== candidatePatch) {
    return { kind: 'invalid', reason: 'patch-id differs', resolution: resolved.resolution }
  }
  const candidatePaths = [...changedPaths(runner, newBase, tip)].sort()
  const reviewedPaths = review.pathSet ? JSON.parse(review.pathSet) as string[] : [...changePaths].sort()
  if (JSON.stringify(reviewedPaths) !== JSON.stringify(candidatePaths)) {
    return { kind: 'invalid', reason: 'path set differs', resolution: resolved.resolution }
  }
  const trunkPaths = changedPaths(runner, oldBase, newBase)
  const overlap = [...changePaths].filter((path) => trunkPaths.has(path))
  if (overlap.length) {
    return { kind: 'invalid', reason: `overlapping paths: ${overlap.sort().join(', ')}`,
      resolution: resolved.resolution }
  }
  const messageResult = runner(['log', '--format=%B', `${newBase}..${tip}`])
  const message = messageResult.ok ? messageResult.out : ''
  return {
    kind: 'carried', class: review.commitMessage !== null && review.commitMessage !== undefined &&
      review.commitMessage !== message ? 'no-code-change' : 'trivial-rebase',
    resolution: resolved.resolution, tip, tree, reviewId: review.id, reviewedCommit, reviewedTree,
    patchId: candidatePatch, oldBase, newBase,
  }
}

type ReviewCoverageSummary = {
  candidateTree: string
  candidatePatch: string
  candidatePaths: string[]
  relevant: ReviewCoverageInput[]
  verdicts: { review: ReviewCoverageInput; verdict: CoverageVerdict }[]
  valid: { review: ReviewCoverageInput; verdict: Extract<CoverageVerdict, { kind: 'exact' | 'carried' }> }[]
  present: string[]
  missing: string[]
  dataProblems: { count: number; example: string | null }
}

function reviewPathSet(review: ReviewCoverageInput): string[] | null {
  if (review.pathSet === null || review.pathSet === undefined) return null
  try {
    const parsed = JSON.parse(review.pathSet)
    return Array.isArray(parsed) && parsed.every((path) => typeof path === 'string')
      ? [...parsed].sort() : null
  } catch { return null }
}

function reviewCoverageSummary(
  project: string, repoRoot: string, branch: string, tip: string, trunk: string,
): ReviewCoverageSummary {
  const treeArgs = ['rev-parse', `${tip}^{tree}`]
  const candidateTree = coverageOutput(coverageGit(repoRoot)(treeArgs), treeArgs)
  const reviews = completedReviews(project)
  const runner = coverageGit(repoRoot)
  const baseArgs = ['merge-base', tip, trunk]
  const baseResult = runner(baseArgs)
  const newBase = baseResult.ok ? baseResult.out : null
  const candidatePatch = newBase
    ? changeIdentity(runner, newBase, tip)
    : `unavailable (git ${baseArgs.join(' ')} failed: ${baseResult.err})`
  const candidatePaths = newBase ? [...changedPaths(runner, newBase, tip)].sort() : []
  const sameIdentity = (review: ReviewCoverageInput) => newBase !== null && review.patchId === candidatePatch &&
    JSON.stringify(reviewPathSet(review)) === JSON.stringify(candidatePaths)
  // Branch metadata scopes stale diagnostics. Stable patch-id plus path set lets
  // the same reviewed diff survive a branch rename without admitting unrelated
  // project reviews into the landing decision. Every review that belongs to the
  // candidate reaches the verdict so legacy tree-plus-base evidence can resolve
  // its identity there.
  const relevant = reviews.filter((review) => reviewBelongsToCandidate(review, branch) || sameIdentity(review))
  const verdicts = relevant.map((review) => ({
    review, verdict: reviewCoverageVerdict(repoRoot, review, tip, trunk),
  }))
  const valid = verdicts.filter((item): item is {
    review: ReviewCoverageInput
    verdict: Extract<CoverageVerdict, { kind: 'exact' | 'carried' }>
  } => item.verdict.kind === 'exact' || item.verdict.kind === 'carried')
  const present = [...new Set(valid.flatMap(({ review }) => review.lenses.map((lens) => lens.lens)))].sort()
  const branchReviews = relevant.filter((review) => reviewBelongsToCandidate(review, branch))
  const expectedFrom = branchReviews.at(-1)
  const expected = expectedFrom
    ? [...new Set(expectedFrom.lenses.map((lens) => lens.lens))].sort()
    : ['correctness']
  const missing = expected.filter((lens) => !present.includes(lens))
  const catalogue = new Set((db().query('SELECT id FROM lens').all() as { id: string }[]).map(({ id }) => id))
  const absent = reviews.flatMap((review) => review.lenses
    .filter((lens) => !catalogue.has(lens.lens))
    .map((lens) => ({ review: review.id, lens: lens.lens })))
  return {
    candidateTree, candidatePatch, candidatePaths, relevant, verdicts, valid, present, missing,
    dataProblems: {
      count: absent.length,
      example: absent[0] ? `review ${absent[0].review} names absent lens ${absent[0].lens}` : null,
    },
  }
}

export function coverageText(
  project: string, repoRoot: string, branch: string, tip: string, trunk: string,
  summary = reviewCoverageSummary(project, repoRoot, branch, tip, trunk),
): string {
  const notEvidence = summary.verdicts.filter(({ verdict }) => verdict.kind === 'invalid')
  const example = notEvidence[0]
  const lines = [
    `branch: ${branch}`,
    `candidate tree: ${summary.candidateTree}`,
    `current patch-id: ${summary.candidatePatch}`,
    `lenses present: ${summary.present.join(', ') || 'none'}`,
    `lenses missing: ${summary.missing.join(', ') || 'none'}`,
  ]
  const evidence = summary.valid[0]
  if (evidence?.verdict.kind === 'exact') lines.push(`review ${evidence.review.id}: exact`)
  if (evidence?.verdict.kind === 'carried') {
    lines.push(`review ${evidence.review.id}: carried (patch-id ${evidence.verdict.patchId}; ` +
      `class ${evidence.verdict.class}; ${evidence.verdict.oldBase}..${evidence.verdict.newBase}) ` +
      `(commit from ${evidence.verdict.resolution})`)
  }
  if (notEvidence.length) {
    lines.push(`${notEvidence.length} review${notEvidence.length === 1 ? '' : 's'} not evidence` +
      (example && example.verdict.kind === 'invalid'
        ? ` (example: review ${example.review.id}, ${example.verdict.reason})` : ''))
  }
  if (summary.dataProblems.count) {
    lines.push(`review data problems: ${summary.dataProblems.count}` +
      (summary.dataProblems.example ? ` (example: ${summary.dataProblems.example})` : ''))
  }
  return lines.join('\n')
}

export class ReviewCoverageRefusal extends Error {
  constructor(
    message: string,
    readonly missing: string[],
    readonly reviewRework: { id: number; reason: string }[],
  ) {
    super(message)
  }
}

export function requireReviewCoverage(
  project: string, repoRoot: string, branch: string, tip: string, trunk: string,
): { tree: string; carry: ReviewCarry | null; validReviewIds: number[] } {
  const summary = reviewCoverageSummary(project, repoRoot, branch, tip, trunk)
  if (summary.dataProblems.count) {
    console.error(`review data problems: ${summary.dataProblems.count}` +
      (summary.dataProblems.example ? ` (example: ${summary.dataProblems.example})` : ''))
  }
  const exact = summary.valid.filter(({ verdict }) => verdict.kind === 'exact')
  if (exact.length) {
    return { tree: summary.candidateTree, carry: null, validReviewIds: exact.map(({ review }) => review.id) }
  }
  const carried = summary.valid.find((item) => item.verdict.kind === 'carried')
  if (carried?.verdict.kind === 'carried') {
    return {
      tree: summary.candidateTree,
      carry: { project, branch, ...carried.verdict },
      validReviewIds: [carried.review.id],
    }
  }
  const reworked = summary.verdicts.flatMap(({ review, verdict }) =>
    verdict.kind === 'invalid' && ['patch-id differs', 'path set differs'].includes(verdict.reason)
      && reviewBelongsToCandidate(review, branch)
      ? [{ id: review.id, reason: verdict.reason }] : [])
  throw new ReviewCoverageRefusal(
    coverageText(project, repoRoot, branch, tip, trunk, summary),
    summary.missing,
    reworked,
  )
}

export function recordReviewCarry(carry: ReviewCarry | null): void {
  if (!carry) return
  db().query(
    `INSERT INTO landing_review_carry
       (project,project_id,branch,tip,tree,review_id,reviewed_commit,reviewed_tree,patch_id,
        old_base,new_base,session_id,at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    carry.project, projectByName(carry.project)?.id ?? null, carry.branch, carry.tip, carry.tree, carry.reviewId,
    carry.reviewedCommit, carry.reviewedTree, carry.patchId, carry.oldBase, carry.newBase,
    sessionId(), nowIso(),
  )
  console.log(
    `review ${carry.reviewId} carried: patch-id ${carry.patchId} unchanged across rebase ` +
    `${carry.oldBase}..${carry.newBase}; gate green on ${carry.tip}`,
  )
}

export function recordReviewInvalidations(
  project: Project, repoRoot: string, trunkOid: string, landedBranch: string,
): { branch: string; reviewId: number }[] {
  const invalidations: { branch: string; reviewId: number }[] = []
  for (const review of completedReviews(project.name)) {
    const branch = review.lenses.find((lens) => lens.branch)?.branch
    if (!branch || branch === landedBranch) continue
    try {
      const gitCwd = review.lenses.find((lens) => lens.launchCwd)?.launchCwd ?? repoRoot
      const runner = coverageGit(gitCwd)
      if (!runner(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok) continue
      const tipArgs = ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]
      const victimTip = coverageOutput(runner(tipArgs), tipArgs)
      // Replay onto the new trunk so merge-base(tip, trunk) is the landed tip and
      // patch-id/content compare the replay, not the unrebased tree. skipExact is
      // required: the unrebased victim tree still matches the review.
      const merge = runner(['merge-tree', '--write-tree', trunkOid, victimTip])
      const mergeTree = merge.out.split('\n')[0]?.trim() ?? ''
      const treeArgs = ['rev-parse', `${victimTip}^{tree}`]
      const tree = /^[0-9a-f]{40,}$/i.test(mergeTree)
        ? mergeTree
        : coverageOutput(runner(treeArgs), treeArgs)
      const syntheticArgs = ['commit-tree', tree, '-p', trunkOid, '-m', 'orch-contention-coverage']
      const synthetic = coverageOutput(runner(syntheticArgs), syntheticArgs)
      const verdict = reviewCoverageVerdict(
        gitCwd, review, synthetic, trunkOid, runner, { skipExact: true },
      )
      if (verdict.kind !== 'invalid') continue
      invalidations.push({ branch, reviewId: review.id })
    } catch { /* a missing path or tree is not this landing's invalidation */ }
  }
  return invalidations
}

export type ReviewListFilter = {
  state?: 'open' | 'complete'
  project?: string
  since?: string
}

export type ReviewListRow = {
  id: number
  recorded_at: string
  completed_at: string | null
  project: string | null
  branches: string[]
  tier: number | null
  risk: number | null
  size: number | null
  lens_count: number
  findings: { total: number; triaged: number; accepted: number; modified: number; rejected: number; skipped: number }
  coverage: 'exact' | 'trivial-rebase' | 'no-code-change' | 'stale' | null
}

type ReviewReadLens = ReviewCoverageInput['lenses'][number] & {
  id: number; runId: number; agent: string; model: string | null; treeInspected: string | null
  reviewRef: string; reproduced: ReviewReproduced | null; coverageGrade: ReviewCoverage | null
  limits: ReviewLimits | null; overlap: ReviewOverlap | null
}

export type ReviewGrades = {
  reproduced: ReviewReproduced
  coverage: ReviewCoverage
  limits: ReviewLimits
  overlap: ReviewOverlap
}

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')
const isCanonSource = (v: unknown): v is CanonSource =>
  typeof v === 'string' && (CANON_SOURCE_SCHEMA.enum as readonly string[]).includes(v)
const exactKeys = (value: object, expected: string[]) => {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, i) => key === [...expected].sort()[i])
}

export function parseReviewReply(value: unknown): ReviewReply | null {
  const v = value as Partial<ReviewReply> | null
  if (!v || typeof v !== 'object' || Array.isArray(v) || !exactKeys(v, ['findings', 'provenance']) ||
      !Array.isArray(v.findings)) return null
  const p = v.provenance
  // The three DEV-371 provenance lists are demanded by the schema, but an agent
  // whose schema binding was dropped (codex with MCP tools active) follows the
  // prose contract only; an absent list reads as empty rather than as a
  // malformed reply, so a review is never lost to a missing empty array.
  const provenanceKeys = [
    'standards_read', 'model_used', 'files_covered', 'commands_run',
    'could_not_verify', 'canon_source',
  ]
  const optionalLists = ['mcp_tools', 'docs_read', 'substitutes'] as const
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    for (const key of optionalLists) {
      if (!(key in p)) (p as Record<string, unknown>)[key] = []
    }
  }
  const withLists = (keys: string[]) => [...keys, ...optionalLists]
  if (!p || typeof p !== 'object' || Array.isArray(p) ||
      !(exactKeys(p, withLists(provenanceKeys)) || exactKeys(p, withLists(['tree_inspected', ...provenanceKeys]))) ||
      (p.tree_inspected !== undefined && p.tree_inspected !== null &&
        typeof p.tree_inspected !== 'string') ||
      typeof p.model_used !== 'string' ||
      !isStrings(p.standards_read) || !isStrings(p.files_covered) ||
      !isStrings(p.commands_run) || !isStrings(p.mcp_tools) || !isStrings(p.docs_read) ||
      !isStrings(p.could_not_verify) || !isStrings(p.substitutes) ||
      !isCanonSource(p.canon_source)) return null
  if (!v.findings.every((f) => f && typeof f === 'object' && !Array.isArray(f) &&
      exactKeys(f, ['severity', 'location', 'evidence', 'proposed_correction']) &&
      typeof f.severity === 'string' && typeof f.location === 'string' &&
      typeof f.evidence === 'string' && typeof f.proposed_correction === 'string')) return null
  if (p.tree_inspected === null) delete (p as Record<string, unknown>).tree_inspected
  return v as ReviewReply
}

export function parseReviewOutput(text: string): ReviewReply | null {
  const candidates = [text.trim(), ...(text.match(/```(?:json)?\s*([\s\S]*?)```/gi) ?? [])
    .map((x) => x.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim())]
  for (const candidate of candidates) {
    try {
      const parsed = parseReviewReply(JSON.parse(candidate))
      if (parsed) return parsed
    } catch { /* try an embedded object */ }
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return parseReviewReply(JSON.parse(text.slice(start, end + 1))) } catch { /* invalid */ }
  }
  return null
}

export const UNEVIDENCED_REVIEW_ERROR =
  'clean review with no evidence: files_covered and commands_run are empty'

export type CleanReviewEvidence =
  | { failure: string; note: null; kind: 'unevidenced' | 'harness' }
  | { failure: null; note: string | null }

export function normalizeCoveredPath(path: string): string {
  const repositoryPath = path.trim()
    .replace(/\s+(?:\u2014|-)\s+.+$/, '')
    .trimEnd()
    .replace(/:\d+(?:-\d+)?$/, '')
  return repositoryPath.trim().replace(/^\.\//, '')
}

/** Classify the evidence on a findings:[] reply against the recorded change path set. */
export function cleanReviewEvidence(
  runId: number, output: ReviewReply, database: Database = db(),
): CleanReviewEvidence {
  const provenance = output.provenance
  provenance.files_covered = provenance.files_covered.map(normalizeCoveredPath)
  if (output.findings.length) return { failure: null, note: null }
  if (!provenance.files_covered.length && !provenance.commands_run.length) {
    return { failure: UNEVIDENCED_REVIEW_ERROR, note: null, kind: 'unevidenced' }
  }
  const unavailable = (why: string): CleanReviewEvidence => ({
    failure: `clean review changed-path coverage not checked: ${why}`,
    note: null,
    kind: 'harness',
  })
  let changed: string[]
  try {
    const stored = storedChangePathSet(runId, database)
    if (stored) changed = stored
    else {
      const run = database.query(
        'SELECT repo, base_commit, input_tree, head_commit, review_ref, changed_paths FROM run WHERE id=?',
      ).get(runId) as (Pick<RunRow,
        'base_commit' | 'input_tree' | 'head_commit' | 'review_ref' | 'changed_paths'
      > & { repo: string | null }) | null
      const range = run ? reviewChangeRange(run) : null
      if (!run?.repo || !range) {
        return unavailable('run lacks repo, base_commit, or input_tree')
      }
      if (range.paths !== null) {
        changed = range.paths
      } else {
        const repo = projectPath(database, run.repo)
        if (!repo) return unavailable(`project ${run.repo} is not registered`)
        const identity = measureChangeIdentity(repo, range.from, range.to)
        if (!identity) return unavailable('git diff --name-only failed')
        changed = identity.paths
      }
    }
  } catch (cause) {
    return unavailable(String((cause as Error)?.message ?? cause))
  }
  if (!changed.length) return unavailable('changed-path set is empty')
  const covered = provenance.files_covered
  // A reviewer commonly reports paths relative to the directory it worked in.
  // Any suffix match establishes some changed-file coverage. If one suffix is
  // ambiguous and matches two changed paths, that still counts for coverage:
  // this gate asks whether the change was read, not which same-named file it was.
  const intersects = changed.some((path) => {
    const normalized = path.replace(/^\.\//, '')
    return covered.some((claim) => normalized === claim || normalized.endsWith(`/${claim}`))
  })
  if (!intersects) {
    return {
      failure: 'clean review with no evidence: files_covered intersects none of the changed paths',
      note: null,
      kind: 'unevidenced',
    }
  }
  return { failure: null, note: null }
}

type RunRow = {
  id: number; agent: string; model: string | null; lens: string | null
  job: string; status: string; output_path: string | null; input_tree: string | null
  head_commit: string | null; repo: string | null; project_id: number | null
  base_commit: string | null; review_ref: string | null; changed_paths: string | null
}

type ReviewChangeRange = { from: string; to: string; paths: string[] | null }

function reviewChangeRange(run: Pick<RunRow,
  'base_commit' | 'input_tree' | 'head_commit' | 'review_ref' | 'changed_paths'
>): ReviewChangeRange | null {
  if (!run.base_commit) return null
  if (run.changed_paths !== null && run.input_tree) {
    const paths = JSON.parse(run.changed_paths)
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) {
      throw new Error('run changed_paths is not a JSON array of paths')
    }
    return { from: run.base_commit, to: run.input_tree, paths }
  }
  // An implicit carried review has no explicit changed-path snapshot, but its
  // committed range is empty while the launch-time input tree contains the
  // reviewed overlay. Preserve that existing clean-review fallback.
  const fallback = run.head_commit === run.base_commit && run.input_tree
    ? run.input_tree
    : run.head_commit ?? run.input_tree
  return fallback ? { from: run.base_commit, to: fallback, paths: null } : null
}

function tierForRuns(runs: RunRow[], database: Database): ReviewTier | null {
  const bases = new Map(runs.map((run) => [run.id, run.base_commit]))
  const trees = new Map(runs.map((run) => [run.id, run.input_tree]))
  const distinctBases = new Set(bases.values())
  const distinctTrees = new Set(trees.values())
  const differ = (values: Map<number, string | null>) => [...values].map(([id, value]) =>
    `run ${id}=${value ?? 'NULL'}`).join(', ')
  if (distinctBases.size !== 1 || distinctTrees.size !== 1) {
    console.error(`warning: review tier not recorded: lens runs differ (${differ(bases)}; ${differ(trees)})`)
    return null
  }
  try {
    for (const run of runs) {
      if (!run.base_commit || !run.input_tree || !run.repo) {
        throw new Error(`run ${run.id} lacks base_commit, input_tree, or repo`)
      }
      const repo = projectPath(database, run.repo)
      if (!repo) throw new Error(`run ${run.id} project ${run.repo} is not registered`)
      const base = git(repo, ['cat-file', '-e', `${run.base_commit}^{commit}`], true)
      if (!base.ok) throw new Error(`run ${run.id} base ${run.base_commit} cannot be resolved`)
      const actualTree = git(repo, ['cat-file', '-t', run.input_tree], true)
      if (!actualTree.ok || actualTree.out !== 'tree') {
        throw new Error(`run ${run.id} reviewed tree ${run.input_tree} cannot be resolved as a tree`)
      }
    }
    const run = runs[0]!
    const repo = projectPath(database, run.repo!)
    return classifyReviewTier({ files: diffNumstat(repo!, run.base_commit!, run.input_tree!) })
  } catch (cause) {
    console.error(`warning: review tier not recorded: ${String((cause as Error)?.message ?? cause)}`)
    return null
  }
}

const pinRef = (runId: number) => `refs/orch/reviewed/${runId}`

function storedChangePathSet(runId: number, database: Database): string[] | null {
  const row = database.query(
    `SELECT review.path_set FROM review_lens
       JOIN review ON review.id = review_lens.review_id
      WHERE review_lens.run_id=?`,
  ).get(runId) as { path_set: string | null } | null
  if (!row || row.path_set === null) return null
  const parsed = JSON.parse(row.path_set)
  if (!Array.isArray(parsed) || parsed.some((path) => typeof path !== 'string')) {
    throw new Error('review path_set is not a JSON array of paths')
  }
  return parsed
}

function measureChangeIdentity(
  repo: string, from: string, to: string,
): { patchId: string; paths: string[]; message: string } | null {
  const paths = git(repo, ['diff', '--name-only', `${from}..${to}`])
  const message = git(repo, ['log', '--format=%B', `${from}..${to}`])
  if (!paths.ok) return null
  let patchId: string
  try {
    patchId = changeIdentity((args, stdin) => git(repo, args, true, stdin), from, to)
  } catch { return null }
  return {
    patchId,
    paths: paths.out ? paths.out.split('\n').sort() : [],
    message: message.ok ? message.out : '',
  }
}

function git(repo: string, args: string[], _hermetic = false, stdin?: Uint8Array): { ok: boolean; out: string; err: string; stdout: Uint8Array } {
  const p = Bun.spawnSync(['git', ...args], {
    cwd: repo, env: targetGitEnvironment(repo), stdin, stdout: 'pipe', stderr: 'pipe',
  })
  return {
    ok: p.exitCode === 0,
    out: p.stdout.toString().trim(),
    err: p.stderr.toString().trim() || `exit ${p.exitCode}`,
    stdout: p.stdout,
  }
}

const reviewGit = (repo: string): CoverageGitRunner => (args, stdin) => git(repo, args, true, stdin)

function projectPath(database: Database, name: string): string | null {
  return (database.query('SELECT path FROM project WHERE name=?').get(name) as
    { path: string } | null)?.path ?? null
}

function reviewReadLenses(reviewId: number, database: Database): ReviewReadLens[] {
  return (database.query(
    `SELECT rl.id, rl.lens, rl.run_id, rl.agent, rl.model, rl.tree_inspected, rl.reviewed_tree,
            rl.reproduced, rl.coverage, rl.limits, rl.overlap,
            run.input_tree, run.branch, run.base_commit, run.launch_cwd, run.head_commit
       FROM review_lens rl JOIN run ON run.id=rl.run_id
      WHERE rl.review_id=? ORDER BY rl.id`,
  ).all(reviewId) as any[]).map((row) => ({
    id: row.id, lens: row.lens, runId: row.run_id, agent: row.agent, model: row.model,
    treeInspected: row.tree_inspected, tree: row.reviewed_tree, inputTree: row.input_tree,
    branch: row.branch, baseCommit: row.base_commit, launchCwd: row.launch_cwd,
    headCommit: row.head_commit, reviewRef: pinRef(row.run_id), reproduced: row.reproduced,
    coverageGrade: row.coverage, limits: row.limits, overlap: row.overlap,
  }))
}

function projectRecord(database: Database, name: string): { path: string; trunk: string } | null {
  const row = database.query('SELECT path, settings FROM project WHERE name=?').get(name) as
    { path: string; settings: string } | null
  if (!row) return null
  let settings: Record<string, unknown> = {}
  try { settings = JSON.parse(row.settings) } catch { return null }
  return { path: row.path, trunk: typeof settings.trunk === 'string' ? settings.trunk.trim() : '' }
}

function currentCoverage(
  review: ReviewCoverageInput, project: string | null, database: Database,
): ReviewListRow['coverage'] {
  if (!project) return null
  const registered = projectRecord(database, project)
  if (!registered?.trunk) return null
  const branches = [...new Set(review.lenses.map((lens) => lens.branch).filter((x): x is string => Boolean(x)))]
  if (!branches.length) return null
  const verdicts = branches.flatMap((branch) => {
    const ref = `refs/heads/${branch}`
    const runner = reviewGit(registered.path)
    const tip = runner(['rev-parse', '--verify', ref])
    if (!tip.ok) return [null]
    const verdict = reviewCoverageVerdict(registered.path, review, tip.out, registered.trunk, runner)
    return [verdict.kind === 'invalid' ? 'stale' as const
      : verdict.kind === 'carried' ? verdict.class : verdict.kind]
  })
  if (verdicts.includes(null)) return null
  if (verdicts.includes('stale')) return 'stale'
  return verdicts.includes('no-code-change') ? 'no-code-change'
    : verdicts.includes('trivial-rebase') ? 'trivial-rebase' : 'exact'
}

export function listReviews(
  filter: ReviewListFilter = {}, database: Database = db(),
): ReviewListRow[] {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.state === 'open') where.push('(r.completed_at IS NULL OR EXISTS (SELECT 1 FROM review_finding open_f WHERE open_f.review_id=r.id AND open_f.disposition IS NULL))')
  if (filter.state === 'complete') where.push('r.completed_at IS NOT NULL')
  if (filter.project) {
    where.push('EXISTS (SELECT 1 FROM review_lens project_l JOIN run project_run ON project_run.id=project_l.run_id WHERE project_l.review_id=r.id AND project_run.repo=?)')
    params.push(filter.project)
  }
  if (filter.since) { where.push('r.recorded_at>=?'); params.push(filter.since) }
  const rows = database.query(
    `SELECT r.id, r.recorded_at, r.completed_at, r.tier, r.tier_risk, r.tier_size,
            COUNT(DISTINCT rl.id) AS lens_count,
            COUNT(DISTINCT rf.id) AS findings_total,
            COUNT(DISTINCT CASE WHEN rf.disposition IS NOT NULL THEN rf.id END) AS findings_triaged,
            COUNT(DISTINCT CASE WHEN rf.disposition='accepted' THEN rf.id END) AS findings_accepted,
            COUNT(DISTINCT CASE WHEN rf.disposition='modified' THEN rf.id END) AS findings_modified,
            COUNT(DISTINCT CASE WHEN rf.disposition='rejected' THEN rf.id END) AS findings_rejected,
            COUNT(DISTINCT CASE WHEN rf.disposition='skipped' THEN rf.id END) AS findings_skipped,
            run.repo AS project, r.patch_id, r.path_set, r.commit_message, r.outdated_reason
       FROM review r JOIN review_lens rl ON rl.review_id=r.id JOIN run ON run.id=rl.run_id
       LEFT JOIN review_finding rf ON rf.review_id=r.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY r.id
      ORDER BY CASE WHEN r.completed_at IS NULL OR EXISTS (SELECT 1 FROM review_finding order_f WHERE order_f.review_id=r.id AND order_f.disposition IS NULL) THEN 0 ELSE 1 END,
               r.recorded_at DESC, r.id DESC`,
  ).all(...params as any[]) as any[]
  return rows.map((row) => {
    const lenses = reviewReadLenses(row.id, database)
    return {
      id: row.id, recorded_at: row.recorded_at, completed_at: row.completed_at,
      project: row.project, branches: [...new Set(lenses.map((lens) => lens.branch).filter(Boolean))] as string[],
      tier: row.tier, risk: row.tier_risk, size: row.tier_size, lens_count: row.lens_count,
      findings: { total: row.findings_total, triaged: row.findings_triaged,
        accepted: row.findings_accepted, modified: row.findings_modified,
        rejected: row.findings_rejected, skipped: row.findings_skipped },
      coverage: currentCoverage({ id: row.id, lenses, patchId: row.patch_id,
        pathSet: row.path_set, commitMessage: row.commit_message,
        outdatedReason: row.outdated_reason }, row.project, database),
    }
  })
}

export function getReview(reviewId: number, database: Database = db()) {
  const review = database.query(
    `SELECT id, recorded_at, completed_at, tier, tier_risk, tier_size, tier_reasons, tier_reason,
            patch_id, path_set, commit_message, outdated_at, outdated_reason FROM review WHERE id=?`,
  ).get(reviewId) as any
  if (!review) throw new Error(`no review ${reviewId}`)
  const lenses = reviewReadLenses(reviewId, database)
  const projects = [...new Set((database.query(
    `SELECT run.repo FROM review_lens rl JOIN run ON run.id=rl.run_id WHERE rl.review_id=? AND run.repo IS NOT NULL`,
  ).all(reviewId) as { repo: string }[]).map((row) => row.repo))]
  return {
    id: review.id, recorded_at: review.recorded_at, completed_at: review.completed_at,
    tier: review.tier, risk: review.tier_risk, size: review.tier_size,
    tier_reasons: review.tier_reasons ? JSON.parse(review.tier_reasons) : null,
    tier_reason: review.tier_reason, projects,
    change_identity: { patch_id: review.patch_id, path_set: review.path_set ? JSON.parse(review.path_set) : null },
    outdated_at: review.outdated_at, outdated_reason: review.outdated_reason,
    current_class: projects.length === 1 ? currentCoverage({ id: reviewId, lenses,
      patchId: review.patch_id, pathSet: review.path_set, commitMessage: review.commit_message,
      outdatedReason: review.outdated_reason }, projects[0]!, database) : null,
    lenses: lenses.map((lens) => {
      const project = projects.length === 1 ? projectRecord(database, projects[0]!) : null
      const pin = project ? git(project.path, ['rev-parse', '--verify', lens.reviewRef], true) : { ok: false, out: '' }
      return {
        run_id: lens.runId, lens: lens.lens, agent: lens.agent, model: lens.model,
        reviewed_tree: lens.tree, head_commit: lens.headCommit, review_ref: lens.reviewRef,
        grading: { reproduced: lens.reproduced, coverage: lens.coverageGrade, limits: lens.limits, overlap: lens.overlap },
        pin: { resolves: pin.ok, commit: pin.ok ? pin.out : null },
      }
    }),
    findings: database.query(
      `SELECT ordinal, severity, location, disposition, rejection_category, evidence, proposed_correction
         FROM review_finding WHERE review_id=? ORDER BY ordinal`,
    ).all(reviewId),
  }
}

function pinReviewedCommits(runs: RunRow[], database: Database): void {
  for (const run of runs) {
    if (!run.head_commit) continue
    const warn = (why: string) => {
      console.error(
        `warning: review run ${run.id} recorded but ${pinRef(run.id)} was not created: ` +
        why,
      )
    }
    try {
      const repo = run.repo ? projectPath(database, run.repo) : null
      if (!repo) {
        warn(`project ${run.repo ?? '(none)'} is not registered`)
        continue
      }
      if (!git(repo, ['cat-file', '-e', `${run.head_commit}^{commit}`]).ok) {
        warn(`commit ${run.head_commit} is missing from ${repo}`)
        continue
      }
      const updated = git(repo, ['update-ref', pinRef(run.id), run.head_commit])
      if (!updated.ok) warn(`git update-ref failed: ${updated.err}`)
    } catch (cause) {
      warn(String((cause as Error)?.message ?? cause))
    }
  }
}

export function recordReviews(
  entries: { runId: number; output: ReviewReply }[], database: Database = writableDb(),
): number {
  if (!entries.length) throw new Error('a review requires at least one lens run')
  const runs = entries.map(({ runId }) => {
    const run = database.query(
      `SELECT id, agent, model, lens, job, status, output_path, input_tree, head_commit, repo, project_id,
              base_commit, review_ref, changed_paths
         FROM run WHERE id=?`,
    ).get(runId) as RunRow | null
    if (!run) throw new Error(`no run ${runId}`)
    if (!job(run.job).findings) throw new Error(`run ${runId} job ${run.job} does not produce review findings`)
    if (!run.lens) throw new Error(`run ${runId} has no lens identity`)
    if (!run.model) throw new Error(`run ${runId} has no effective model recorded`)
    if (run.status !== 'ok') throw new Error(`run ${runId} is ${run.status}, not a completed review run`)
    const existing = database.query('SELECT review_id FROM review_lens WHERE run_id=?').get(runId) as
      { review_id: number } | null
    if (existing) throw new Error(`run ${runId} is already recorded in review ${existing.review_id}`)
    return run
  })
  const projects = [...new Set(runs.map((run) => run.repo))]
  if (projects.length > 1) {
    throw new Error(`review lens runs belong to different projects: ${projects.map((project) => project ?? '(none)').join(', ')}`)
  }
  const measuredTrees = runs.filter((run) => run.input_tree !== null)
  const distinctTrees = new Set(measuredTrees.map((run) => run.input_tree))
  if (distinctTrees.size > 1) {
    throw new Error(
      `review lens runs measured different trees:\n${runs.map((run) =>
        `run ${run.id}: ${run.input_tree ?? 'NULL'}`).join('\n')}`,
    )
  }
  const identity = (() => {
    const run = runs[0]!
    const range = reviewChangeRange(run)
    if (!run.repo || !range) return null
    const repo = projectPath(database, run.repo)
    if (!repo) return null
    const measured = measureChangeIdentity(repo, range.from, range.to)
    return measured && range.paths !== null ? { ...measured, paths: range.paths } : measured
  })()
  const reviewId = writeTransaction(() => {
    const tier = tierForRuns(runs, database)
    const review = database.query(
      `INSERT INTO review (recorded_at, tier, tier_risk, tier_size, tier_reasons, tier_reason, project_id,
                           patch_id, path_set, commit_message)
       VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    ).get(nowIso(), tier?.tier ?? null, tier?.risk ?? null, tier?.size ?? null,
      tier ? JSON.stringify(tier.reasons) : null,
      tier ? tier.reasons[tier.risk >= tier.size ? 0 : 1] : null,
      runs.every((run)=>run.project_id===runs[0]!.project_id)?runs[0]!.project_id:null,
      identity?.patchId ?? null, identity ? JSON.stringify(identity.paths) : null,
      identity?.message ?? null) as { id: number }
    const insertLens = database.query(
      `INSERT INTO review_lens
         (review_id, run_id, lens, agent, model, tree_inspected, reviewed_tree, standards_read,
          files_covered, commands_run, could_not_verify, mcp_tools, docs_read, substitutes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    )
    const insert = database.query(
      `INSERT INTO review_finding
         (review_id, review_lens_id, ordinal, severity, location, evidence, proposed_correction)
       VALUES (?,?,?,?,?,?,?)`,
    )
    let ordinal = 0
    entries.forEach(({ output }, index) => {
      const run = runs[index]!
      output.provenance.files_covered = output.provenance.files_covered.map(normalizeCoveredPath)
      const lens = insertLens.get(review.id, run.id, run.lens, run.agent, run.model,
        output.provenance.tree_inspected ?? null, run.input_tree,
        JSON.stringify(output.provenance.standards_read),
        JSON.stringify(output.provenance.files_covered), JSON.stringify(output.provenance.commands_run),
        JSON.stringify(output.provenance.could_not_verify), JSON.stringify(output.provenance.mcp_tools),
        JSON.stringify(output.provenance.docs_read), JSON.stringify(output.provenance.substitutes)) as { id: number }
      output.findings.forEach((finding) => insert.run(
        review.id, lens.id, ++ordinal, finding.severity, finding.location, finding.evidence,
        finding.proposed_correction,
      ))
    })
    return review.id
  }, database)
  pinReviewedCommits(runs, database)
  return reviewId
}

export type ReviewPin = {
  project: string
  runId: number
  reviewId: number
  commit: string
  completed: boolean
  superseded: boolean
  landed: boolean
  deleted: boolean
}

export type CoverageAudit = {
  count: number
  review_ids: number[]
  partial_review_ids: number[]
}

/** Find completed reviews whose lenses measured trunk at their own worktree cut. */
export function coverageAudit(database: Database = db()): CoverageAudit {
  const projects = database.query('SELECT name, path, settings FROM project').all() as {
    name: string; path: string; settings: string | null
  }[]
  const registered = new Map<string, { path: string; trunk: string | null }>()
  for (const project of projects) {
    let trunk: string | null = null
    try {
      const settings = JSON.parse(project.settings ?? '{}') as { trunk?: unknown }
      if (typeof settings.trunk === 'string' && settings.trunk.trim()) trunk = settings.trunk
    } catch { /* an unreadable project setting cannot identify trunk */ }
    registered.set(project.name, { path: project.path, trunk })
  }
  const rows = database.query(
    `SELECT review.id, run.repo, run.started_at, run.base_commit, review_lens.reviewed_tree
       FROM review
       JOIN review_lens ON review_lens.review_id=review.id
       JOIN run ON run.id=review_lens.run_id
      WHERE review.completed_at IS NOT NULL AND run.review_ref IS NULL
      ORDER BY review.id, review_lens.id`,
  ).all() as {
    id: number; repo: string | null; started_at: string; base_commit: string | null
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
          'log', '-n', '2000', '--format=%T', `--before=${row.started_at}`, project.trunk,
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

/** Inspect keepalive refs; pruning is an explicit act and never part of cleanup. */
export function reviewPins(prune = false, database: Database = db()): ReviewPin[] {
  if (prune) writableDb()
  const registered = new Map((database.query(
    'SELECT name, path, settings FROM project',
  ).all() as { name: string; path: string; settings: string }[]).map((project) => {
    let settings: Record<string, unknown> = {}
    try { settings = JSON.parse(project.settings) } catch { /* unreadable settings have no trunk */ }
    return [project.name, { path: project.path, settings }] as const
  }))
  const rows = database.query(
    `SELECT run.repo, run.branch, run.id AS run_id, rl.review_id, r.completed_at
       FROM review_lens rl
       JOIN review r ON r.id=rl.review_id
       JOIN run ON run.id=rl.run_id
      WHERE run.head_commit IS NOT NULL
      ORDER BY run.repo, run.id`,
  ).all() as {
    repo: string | null; branch: string | null; run_id: number
    review_id: number; completed_at: string | null
  }[]
  const pins: ReviewPin[] = []
  for (const row of rows) {
    if (!row.repo) continue
    const project = registered.get(row.repo)
    if (!project) continue
    const ref = git(project.path, ['rev-parse', '--verify', pinRef(row.run_id)])
    if (!ref.ok) continue
    const superseded = Boolean(database.query(
      `SELECT 1
         FROM review_lens newer_lens
         JOIN review newer ON newer.id=newer_lens.review_id
         JOIN run newer_run ON newer_run.id=newer_lens.run_id
        WHERE newer.id>? AND newer_run.repo=? AND newer_run.branch IS ?
        LIMIT 1`,
    ).get(row.review_id, row.repo, row.branch))
    const trunk = typeof project.settings.trunk === 'string' ? project.settings.trunk.trim() : ''
    const landed = Boolean(row.branch && trunk &&
      git(project.path, ['show-ref', '--verify', '--quiet', `refs/heads/${row.branch}`]).ok &&
      git(project.path, [
        'merge-base', '--is-ancestor', `refs/heads/${row.branch}`, `refs/heads/${trunk}`,
      ]).ok)
    let deleted = false
    if (prune && row.completed_at !== null && landed) {
      const removal = git(project.path, ['update-ref', '-d', pinRef(row.run_id)])
      if (!removal.ok) throw new Error(`git update-ref -d ${pinRef(row.run_id)} failed: ${removal.err}`)
      deleted = true
    }
    pins.push({
      project: row.repo, runId: row.run_id, reviewId: row.review_id, commit: ref.out,
      completed: row.completed_at !== null, superseded, landed, deleted,
    })
  }
  return pins
}

export function recordReview(runId: number, output: ReviewReply, database: Database = writableDb()): number {
  return recordReviews([{ runId, output }], database)
}

export function gradeReviewLens(
  runId: number, output: ReviewReply | null, grades: ReviewGrades, database: Database = writableDb(),
): number {
  let row = database.query('SELECT id, review_id FROM review_lens WHERE run_id=?').get(runId) as
    { id: number; review_id: number } | null
  if (!row) {
    if (!output) throw new Error(`run ${runId} has no review output to record`)
    // The scoring path records through recordReview so it shares the same
    // best-effort commit pinning as `orch review record`.
    const reviewId = recordReview(runId, output, database)
    row = database.query('SELECT id, review_id FROM review_lens WHERE run_id=?').get(runId) as
      { id: number; review_id: number }
    if (row.review_id !== reviewId) throw new Error(`run ${runId} review capture did not persist`)
  }
  database.query(
    `UPDATE review_lens SET reproduced=?, coverage=?, limits=?, overlap=? WHERE id=?`,
  ).run(grades.reproduced, grades.coverage, grades.limits, grades.overlap, row.id)
  return row.review_id
}

export function triageFinding(
  reviewId: number, ordinal: number, disposition: Disposition,
  rejectionCategory?: string, triagedSeverity?: string, database: Database = writableDb(),
): void {
  if (!DISPOSITIONS.includes(disposition)) throw new Error(`invalid disposition: ${disposition}`)
  if (disposition === 'rejected' && !rejectionCategory?.trim()) {
    throw new Error('a rejected finding requires --category')
  }
  if (rejectionCategory && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(rejectionCategory)) {
    throw new Error('rejection category must be a lowercase stable id of at most 64 characters')
  }
  const review = database.query('SELECT completed_at FROM review WHERE id=?').get(reviewId) as
    { completed_at: string | null } | null
  if (!review) throw new Error(`no review ${reviewId}`)
  if (review.completed_at) throw new Error(`review ${reviewId} is already complete`)
  const finding = database.query(
    'SELECT severity FROM review_finding WHERE review_id=? AND ordinal=?',
  ).get(reviewId, ordinal) as { severity: string } | null
  if (!finding) throw new Error(`review ${reviewId} has no finding ${ordinal}`)
  const severity = triagedSeverity?.trim()
  if (severity && !REVIEW_SEVERITY.includes(severity as ReviewSeverity)) {
    throw new Error(`severity must be: ${REVIEW_SEVERITY.join(' | ')}`)
  }
  const result = database.query(
    `UPDATE review_finding SET disposition=?, rejection_category=?, triaged_severity=?, triaged_at=?
       WHERE review_id=? AND ordinal=?`,
  ).run(disposition, disposition === 'rejected' ? rejectionCategory!.trim() : null,
    severity ?? null,
    nowIso(), reviewId, ordinal)
  if (result.changes !== 1) throw new Error(`review ${reviewId} has no finding ${ordinal}`)
}

export function completeReview(reviewId: number, database: Database = writableDb()): void {
  const row = database.query(
    `SELECT COUNT(*) AS findings,
            SUM(CASE WHEN disposition IS NULL THEN 1 ELSE 0 END) AS untriaged
       FROM review_finding WHERE review_id=?`,
  ).get(reviewId) as { findings: number; untriaged: number | null }
  const review = database.query('SELECT id FROM review WHERE id=?').get(reviewId)
  if (!review) throw new Error(`no review ${reviewId}`)
  if ((row.untriaged ?? 0) > 0) throw new Error(`review ${reviewId} still has ${row.untriaged} untriaged findings`)
  database.query('UPDATE review SET completed_at=? WHERE id=?').run(nowIso(), reviewId)
}

export type ReviewCalibration = {
  lens: string; agent: string; model: string | null; precision: number | null
  hits: number; triaged: number; rejection_categories: { category: string; count: number }[]
  /** Completed lens runs that explicitly degraded from requested MCP to the mirror. */
  mirror_lenses: number
  basis: 'model' | 'agent' | null
  reproduced: GradeDistribution<ReviewReproduced>
  coverage: GradeDistribution<ReviewCoverage>
  limits: GradeDistribution<ReviewLimits>
  overlap: GradeDistribution<ReviewOverlap>
  severity: SeverityAgreement
  tiers: Record<'0' | '1' | '2' | '3' | 'unclassified', TierCalibration>
}

export type TierCalibration = {
  reviews: number; lenses: number; findings_accepted: number; findings_rejected: number
  rounds: { min: number | null; median: number | null; max: number | null }
}

export type GradeDistribution<T extends string> = {
  counts: Record<T, number>
  shares: Record<T, number | null>
  ungraded: number
}

export type SeverityAgreement = {
  counts: { agreed: number; changed: number; not_comparable: number; not_assessed: number }
  shares: { agreed: number | null; changed: number | null; not_comparable: number | null; not_assessed: number | null }
}

function gradeDistribution<T extends string>(
  rows: Record<string, unknown>[], column: string, values: readonly T[],
): GradeDistribution<T> {
  const counts = Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>
  let ungraded = 0
  for (const row of rows) {
    const value = row[column]
    if (typeof value === 'string' && values.includes(value as T)) counts[value as T]++
    else ungraded++
  }
  const graded = rows.length - ungraded
  const shares = Object.fromEntries(values.map((value) => [
    value, graded > 0 ? counts[value] / graded : null,
  ])) as Record<T, number | null>
  return { counts, shares, ungraded }
}

function severityAgreement(
  rows: { severity: string; triaged_severity: string | null }[],
): SeverityAgreement {
  const counts = { agreed: 0, changed: 0, not_comparable: 0, not_assessed: 0 }
  for (const row of rows) {
    if (row.triaged_severity === null) counts.not_assessed++
    else if (!REVIEW_SEVERITY.includes(row.severity as ReviewSeverity)) counts.not_comparable++
    else if (row.triaged_severity === row.severity) counts.agreed++
    else counts.changed++
  }
  const total = rows.length
  return {
    counts,
    shares: {
      agreed: total ? counts.agreed / total : null,
      changed: total ? counts.changed / total : null,
      not_comparable: total ? counts.not_comparable / total : null,
      not_assessed: total ? counts.not_assessed / total : null,
    },
  }
}

function calibrationCell(
  lens: string, agent: string, model: string | null | undefined, database: Database,
): Omit<ReviewCalibration, 'basis'> {
  const modelClause = model === undefined ? '' : 'AND rl.model IS ?'
  const reviews = database.query(
    `SELECT DISTINCT r.id FROM review r JOIN review_lens rl ON rl.review_id=r.id
      JOIN run ON run.id=rl.run_id
      WHERE rl.lens=? AND rl.agent=? AND ${completedReviewEvidenceSql('r', 'run', 'rl')} ${modelClause}
      ORDER BY r.completed_at DESC, r.id DESC LIMIT ?`,
  ).all(...(model === undefined ? [lens, agent, REVIEW_WINDOW] : [lens, agent, model, REVIEW_WINDOW])) as { id: number }[]
  const emptyTiers = () => Object.fromEntries(['0', '1', '2', '3', 'unclassified'].map((key) =>
    [key, { reviews: 0, lenses: 0, findings_accepted: 0, findings_rejected: 0,
      rounds: { min: null, median: null, max: null } }])) as ReviewCalibration['tiers']
  const emptyGrades = () => ({
    reproduced: gradeDistribution([], 'reproduced', REVIEW_REPRODUCED),
    coverage: gradeDistribution([], 'coverage', REVIEW_COVERAGE),
    limits: gradeDistribution([], 'limits', REVIEW_LIMITS),
    overlap: gradeDistribution([], 'overlap', REVIEW_OVERLAP),
    severity: severityAgreement([]),
    tiers: emptyTiers(),
  })
  if (!reviews.length) return { lens, agent, model: model ?? null, precision: null, hits: 0, triaged: 0, rejection_categories: [], mirror_lenses: 0, ...emptyGrades() }
  const ids = reviews.map((r) => r.id)
  const marks = ids.map(() => '?').join(',')
  const counts = database.query(
    `SELECT
       SUM(CASE WHEN disposition IN ('accepted','modified') THEN 1 ELSE 0 END) AS hits,
       SUM(CASE WHEN disposition IN ('accepted','modified','rejected') THEN 1 ELSE 0 END) AS triaged
     FROM review_finding rf JOIN review_lens rl ON rl.id=rf.review_lens_id
     WHERE rf.review_id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}`,
  ).get(...ids, lens, agent, ...(model === undefined ? [] : [model])) as { hits: number | null; triaged: number | null }
  const categories = database.query(
    `SELECT rejection_category AS category, COUNT(*) AS count
       FROM review_finding rf JOIN review_lens rl ON rl.id=rf.review_lens_id
      WHERE rf.review_id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}
        AND disposition='rejected' AND rejection_category IS NOT NULL
      GROUP BY rejection_category ORDER BY count DESC, category LIMIT 3`,
  ).all(...ids, lens, agent, ...(model === undefined ? [] : [model])) as { category: string; count: number }[]
  const triaged = counts.triaged ?? 0
  const hits = counts.hits ?? 0
  const mirrorLenses = database.query(
    `SELECT COUNT(*) AS count FROM review_lens rl JOIN run ON run.id=rl.run_id
      WHERE rl.review_id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}
        AND run.mcp_connected=0 AND run.mcp_error LIKE 'mirror:%'`,
  ).get(...ids, lens, agent, ...(model === undefined ? [] : [model])) as { count: number }
  const gradeRows = database.query(
    `SELECT reproduced, coverage, limits, overlap FROM review_lens rl
      WHERE rl.review_id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}`,
  ).all(...ids, lens, agent, ...(model === undefined ? [] : [model])) as Record<string, unknown>[]
  const severityRows = database.query(
    `SELECT rf.severity, rf.triaged_severity FROM review_finding rf
      JOIN review_lens rl ON rl.id=rf.review_lens_id
      WHERE rf.review_id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}
        AND rf.disposition IS NOT NULL`,
  ).all(...ids, lens, agent, ...(model === undefined ? [] : [model])) as
    { severity: string; triaged_severity: string | null }[]
  const tierRows = database.query(
    `SELECT r.id AS review_id, r.tier, rl.id AS lens_id, rf.disposition
       FROM review r JOIN review_lens rl ON rl.review_id=r.id
       LEFT JOIN review_finding rf ON rf.review_lens_id=rl.id
      WHERE r.id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}`,
  ).all(...ids, lens, agent, ...(model === undefined ? [] : [model])) as
    { review_id: number; tier: number | null; lens_id: number; disposition: string | null }[]
  const tiers = emptyTiers()
  const tierReviews = new Map<string, Set<number>>()
  const tierLenses = new Map<string, Set<number>>()
  for (const row of tierRows) {
    const key = row.tier === null ? 'unclassified' : String(row.tier)
    const cell = tiers[key as keyof typeof tiers]
    if (!cell) continue
    const reviews = tierReviews.get(key) ?? new Set<number>()
    const lenses = tierLenses.get(key) ?? new Set<number>()
    reviews.add(row.review_id); lenses.add(row.lens_id)
    tierReviews.set(key, reviews); tierLenses.set(key, lenses)
    if (row.disposition === 'accepted') cell.findings_accepted++
    if (row.disposition === 'rejected') cell.findings_rejected++
  }
  for (const [key, cell] of Object.entries(tiers)) {
    cell.reviews = tierReviews.get(key)?.size ?? 0
    cell.lenses = tierLenses.get(key)?.size ?? 0
  }
  const identityRows = database.query(
    `SELECT r.id AS review_id, r.tier, rl.id AS lens_id, run.branch, run.launch_key
       FROM review r JOIN review_lens rl ON rl.review_id=r.id
       JOIN run ON run.id=rl.run_id
      WHERE r.id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}
      ORDER BY r.id, rl.id`,
  ).all(...ids, lens, agent, ...(model === undefined ? [] : [model])) as
    { review_id: number; tier: number | null; lens_id: number; branch: string | null; launch_key: string | null }[]
  const firstIdentity = new Map<number, typeof identityRows[number]>()
  for (const row of identityRows) if (!firstIdentity.has(row.review_id)) firstIdentity.set(row.review_id, row)
  const roundCounts = new Map<string, Map<string, number>>()
  for (const row of firstIdentity.values()) {
    const tier = row.tier === null ? 'unclassified' : String(row.tier)
    const identities = roundCounts.get(tier) ?? new Map<string, number>()
    const identity = row.launch_key ?? row.branch ?? `review:${row.review_id}`
    identities.set(identity, (identities.get(identity) ?? 0) + 1)
    roundCounts.set(tier, identities)
  }
  for (const [key, cell] of Object.entries(tiers)) {
    const values = [...(roundCounts.get(key)?.values() ?? [])]
    if (values.length) cell.rounds = {
      min: Math.min(...values), median: median(values), max: Math.max(...values),
    }
  }
  return { lens, agent, model: model ?? null,
    precision: triaged >= MIN_REVIEW_TRIAGED ? hits / triaged : null,
    hits, triaged, rejection_categories: categories, mirror_lenses: mirrorLenses.count,
    reproduced: gradeDistribution(gradeRows, 'reproduced', REVIEW_REPRODUCED),
    coverage: gradeDistribution(gradeRows, 'coverage', REVIEW_COVERAGE),
    limits: gradeDistribution(gradeRows, 'limits', REVIEW_LIMITS),
    overlap: gradeDistribution(gradeRows, 'overlap', REVIEW_OVERLAP),
    severity: severityAgreement(severityRows),
    tiers,
  }
}

export function reviewCalibration(
  lens: string, agent: string, model: string, database: Database = db(),
): ReviewCalibration {
  const specific = calibrationCell(lens, agent, model, database)
  if (specific.triaged >= MIN_REVIEW_TRIAGED) return { ...specific, basis: 'model' }
  const aggregate = calibrationCell(lens, agent, undefined, database)
  if (aggregate.triaged >= MIN_REVIEW_TRIAGED) return { ...aggregate, model: null, basis: 'agent' }
  return { ...aggregate, precision: null, model: null, basis: null }
}

export type ReviewCalibrationFleetCell = {
  lens: string
  agent: string
  model: string | null
  n: number
  precision: number | null
  basis: 'model' | 'aggregate' | null
  last_graded_at: string | null
}

export function reviewCalibrationFleet(database: Database = db()): ReviewCalibrationFleetCell[] {
  const identities = database.query(
    `SELECT DISTINCT lens, agent FROM review_lens ORDER BY lens, agent`,
  ).all() as { lens: string; agent: string }[]
  const lenses = [...new Set(identities.map((row) => row.lens))]
  const agents = [...new Set(identities.map((row) => row.agent))]
  const graded = database.query(
    `SELECT rl.lens, rl.agent, rl.model, MAX(s.scored_at) AS last_graded_at
       FROM review_lens rl JOIN review r ON r.id=rl.review_id
       LEFT JOIN score s ON s.run_id=rl.run_id
      WHERE r.completed_at IS NOT NULL
        AND (rl.reproduced IS NOT NULL OR rl.coverage IS NOT NULL OR rl.limits IS NOT NULL OR rl.overlap IS NOT NULL)
      GROUP BY rl.lens, rl.agent, rl.model ORDER BY rl.lens, rl.agent, rl.model`,
  ).all() as { lens: string; agent: string; model: string | null; last_graded_at: string | null }[]
  const pairHasGrade = new Set(graded.map((row) => `${row.lens}\0${row.agent}`))
  const pairLastGraded = new Map<string, string | null>()
  for (const row of graded) {
    const key = `${row.lens}\0${row.agent}`
    const prior = pairLastGraded.get(key)
    if (row.last_graded_at && (!prior || row.last_graded_at > prior)) pairLastGraded.set(key, row.last_graded_at)
  }
  const cells = new Map<string, ReviewCalibrationFleetCell>()
  for (const row of graded) {
    if (row.model === null) {
      const aggregate = calibrationCell(row.lens, row.agent, undefined, database)
      cells.set(`${row.lens}\0${row.agent}\0`, {
        lens: row.lens, agent: row.agent, model: null, n: aggregate.triaged,
        precision: aggregate.precision, basis: 'aggregate',
        last_graded_at: pairLastGraded.get(`${row.lens}\0${row.agent}`) ?? null,
      })
      continue
    }
    const specific = calibrationCell(row.lens, row.agent, row.model, database)
    cells.set(`${row.lens}\0${row.agent}\0${row.model}`, {
      lens: row.lens, agent: row.agent, model: row.model, n: specific.triaged,
      precision: specific.precision, basis: 'model', last_graded_at: row.last_graded_at,
    })
    if (specific.triaged < MIN_REVIEW_TRIAGED) {
      const aggregate = calibrationCell(row.lens, row.agent, undefined, database)
      if (aggregate.triaged >= MIN_REVIEW_TRIAGED) {
        cells.set(`${row.lens}\0${row.agent}\0`, {
          lens: row.lens, agent: row.agent, model: null, n: aggregate.triaged,
          precision: aggregate.precision, basis: 'aggregate',
          last_graded_at: pairLastGraded.get(`${row.lens}\0${row.agent}`) ?? null,
        })
      }
    }
  }
  for (const lens of lenses) for (const agent of agents) {
    if (!pairHasGrade.has(`${lens}\0${agent}`)) {
      cells.set(`${lens}\0${agent}\0`, {
        lens, agent, model: null, n: 0, precision: null, basis: null, last_graded_at: null,
      })
    }
  }
  return [...cells.values()].sort((a, b) => a.lens.localeCompare(b.lens) || a.agent.localeCompare(b.agent) ||
    String(a.model).localeCompare(String(b.model)))
}

export function calibrationLine(calibration: ReviewCalibration): string {
  const gradeSummary = (name: keyof Pick<ReviewCalibration, 'reproduced' | 'coverage' | 'limits' | 'overlap'>) => {
    const distribution = calibration[name]
    const counts = Object.entries(distribution.counts).map(([value, count]) => `${value} ${count}`).join(', ')
    return `${name}: ${counts}; ungraded ${distribution.ungraded}`
  }
  const severity = ` Severity agreement: agreed ${calibration.severity.counts.agreed}, changed ${calibration.severity.counts.changed}, not-comparable ${calibration.severity.counts.not_comparable}, not-assessed ${calibration.severity.counts.not_assessed}.`
  const mirror = ` MIRROR lenses: ${calibration.mirror_lenses}.`
  const grades = `${mirror} Review grades: ${gradeSummary('reproduced')}; ${gradeSummary('coverage')}; ${gradeSummary('limits')}; ${gradeSummary('overlap')}.${severity}`
  if (calibration.precision === null) {
    return `Reviewer calibration: no reliable precision yet for lens ${calibration.lens} on agent ${calibration.agent}.${grades}`
  }
  const rejected = calibration.rejection_categories.length
    ? ` Frequent rejection categories: ${calibration.rejection_categories.map((x) => `${x.category} (${x.count})`).join(', ')}.`
    : ''
  const scope = calibration.basis === 'model' ? `model ${calibration.model}` : 'all models'
  return `Reviewer calibration: lens ${calibration.lens} on agent ${calibration.agent} (${scope}) has precision ${calibration.precision.toFixed(2)} over ${calibration.triaged} triaged findings.${rejected}${grades}`
}

/** Reserved during routing so argv eligibility remains true after calibration is appended. */
export const CALIBRATION_SUFFIX_RESERVE_BYTES = 1024

export { REVIEW_SCHEMA }
