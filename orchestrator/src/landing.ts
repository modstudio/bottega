import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db, liveRunCount, nowIso, sessionId, writableDb } from './db.ts'
import { formatGitLocks } from './git-locks.ts'
import { projectAt, type Project } from './projects.ts'
import {
  contentTree, prepareSharedRefGuard, projectLockState, repoRootOf, withProjectLock,
  targetGitEnvironment, type SharedRefGuardEnvironment,
} from './worktree.ts'

const LANDING_LOCK = 'landing'
const LANDING_LOCK_TIMEOUT_MS = 5 * 60_000
const GATE_FAILURE_TAIL_LINES = 40

function gateFailureLines(output: string): string[] {
  return output.split('\n').map(stripAnsi).filter((line) =>
    /^\s*(?:\(fail\)|✗)\s+/.test(line) || /^\s*\d+\s+fail(?:s|ed)?\b/.test(line))
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

export function gateFailureSummary(
  output: string, outputPath: string, liveRuns: number, truncated = false,
): string {
  const lines = output.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const failures = gateFailureLines(output)
  const timeout = output.split('\n').some((line) =>
    /^\s*\^ this test timed out after \d+ms\.\s*$/.test(stripAnsi(line)))
  return [
    truncated
      ? 'gate output (TRUNCATED after 5 s: a process the gate left behind still held its ' +
        `output pipe): ${outputPath}`
      : `complete gate output: ${outputPath}`,
    ...(timeout
      ? [`gate timeout under load: ${liveRuns} orch runs live (running + asking) machine-wide`]
      : []),
    'gate failures:',
    ...(failures.length ? failures : ['no failing test named in the captured output']),
    `gate output tail (last ${GATE_FAILURE_TAIL_LINES} lines):`,
    ...lines.slice(-GATE_FAILURE_TAIL_LINES),
  ].join('\n')
}

function gateOutputPaths(project: string): { directory: string; output: string } {
  const safeProject = project.replace(/[^a-zA-Z0-9._-]+/g, '-')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const directory = join(tmpdir(), `orch-gate-${safeProject}-${timestamp}-${randomUUID()}`)
  mkdirSync(directory)
  return {
    directory,
    output: join(directory, 'output.log'),
  }
}

function prepareGateCapture(project: string):
  | { ok: true; paths: ReturnType<typeof gateOutputPaths>; pipe: string }
  | { ok: false; error: string } {
  let paths: ReturnType<typeof gateOutputPaths> | null = null
  try {
    paths = gateOutputPaths(project)
    writeFileSync(paths.output, '')
    const pipe = join(paths.directory, 'output.pipe')
    const made = Bun.spawnSync(['mkfifo', pipe], { stdout: 'pipe', stderr: 'pipe' })
    if (made.exitCode !== 0) {
      throw new Error(made.stderr.toString().trim() || `mkfifo exited ${made.exitCode}`)
    }
    if (!statSync(pipe).isFIFO()) throw new Error(`${pipe} is not a fifo`)
    return { ok: true, paths, pipe }
  } catch (error) {
    if (paths) rmSync(paths.directory, { recursive: true, force: true })
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function git(
  cwd: string, args: string[], guard?: SharedRefGuardEnvironment,
): string {
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: { ...targetGitEnvironment(cwd), ...guard }, stdout: 'pipe', stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString().trim() || `exit ${p.exitCode}`}`)
  }
  return p.stdout.toString().trim()
}

function gitOk(cwd: string, args: string[], guard?: SharedRefGuardEnvironment): boolean {
  return Bun.spawnSync(['git', ...args], {
    cwd, env: { ...targetGitEnvironment(cwd), ...guard }, stdout: 'ignore', stderr: 'ignore',
  }).exitCode === 0
}

function registeredProject(cwd: string): { project: Project; repoRoot: string } {
  const project = projectAt(cwd)
  if (!project) throw new Error(`cannot land from ${cwd}: it is not inside a registered project`)
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`cannot land from ${cwd}: it is not a git repository`)
  return { project, repoRoot }
}

export function resolveLandingBranch(value: string): { branch: string; runId: number | null } {
  if (!/^\d+$/.test(value)) return { branch: value, runId: null }
  const runId = Number(value)
  const row = db().query('SELECT branch FROM run WHERE id=?').get(runId) as { branch: string | null } | null
  if (!row) throw new Error(`no run ${runId}`)
  if (!row.branch) throw new Error(`run ${runId} has no branch and cannot be landed`)
  return { branch: row.branch, runId }
}

function worktreesForBranch(repoRoot: string, branch: string): string[] {
  const lines = git(repoRoot, ['worktree', 'list', '--porcelain']).split('\n')
  let path: string | null = null
  const matches: string[] = []
  for (const line of lines) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line === `branch refs/heads/${branch}` && path) matches.push(path)
    else if (!line) path = null
  }
  return matches
}

type CheckoutState = {
  path: string
  trackedWork: boolean
  indexAtExpected: boolean
  detail: string
  preservedIndex: string | null
}

function checkoutState(path: string, expected: string): CheckoutState {
  try {
    const status = git(path, ['status', '--porcelain=v1', '--untracked-files=no'])
    const indexAtExpected = git(path, ['write-tree']) === git(path, ['rev-parse', `${expected}^{tree}`])
    return {
      path, trackedWork: status !== '', indexAtExpected,
      detail: status || 'clean', preservedIndex: null,
    }
  } catch (error) {
    return {
      path,
      trackedWork: true,
      indexAtExpected: false,
      detail: error instanceof Error ? error.message : String(error),
      preservedIndex: null,
    }
  }
}

function preserveIndex(checkout: CheckoutState, guard: SharedRefGuardEnvironment): string {
  const preserved = git(checkout.path, [
    'stash', 'create', `orch landing preservation for ${checkout.path}`,
  ], guard)
  if (!preserved) {
    throw new Error(`git stash create returned no recovery object for tracked work in ${checkout.path}`)
  }
  return preserved
}

function recoveryRef(checkout: CheckoutState, preserved: string): string {
  return `refs/orch/preserved-index/${Date.now()}-${randomUUID()}-${preserved.slice(0, 12)}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function reconcileTrunkCheckouts(
  checkouts: CheckoutState[], trunk: string, tip: string, expected: string,
  guard: SharedRefGuardEnvironment,
): void {
  for (const checkout of checkouts) {
    try {
      if (!checkout.indexAtExpected) {
        throw new Error('checkout index held tracked work before landing')
      }
      git(checkout.path, ['read-tree', '-m', '-u', expected, tip], guard)
      if (git(checkout.path, ['write-tree'], guard) !== git(checkout.path, ['rev-parse', `${tip}^{tree}`], guard)) {
        throw new Error('git did not leave the checkout index at the landed tree')
      }
      console.log(`reconciled checkout ${checkout.path} to ${trunk} at ${tip}`)
    } catch (error) {
      const currentIndex = git(checkout.path, ['write-tree'], guard)
      const preLandingIndex = checkout.preservedIndex
        ? git(checkout.path, ['rev-parse', `${checkout.preservedIndex}^2^{tree}`], guard)
        : null
      const preserved = preLandingIndex === currentIndex
        ? checkout.preservedIndex!
        : preserveIndex({ ...checkout, trackedWork: true }, guard)
      const ref = recoveryRef(checkout, preserved)
      git(checkout.path, ['update-ref', ref, preserved, '0000000000000000000000000000000000000000'], guard)
      // Index only: working-tree bytes are the person's state and must not move.
      git(checkout.path, ['read-tree', '--reset', tip], guard)
      const detail = checkout.trackedWork ? checkout.detail : 'git refused the checkout update'
      const command = `git -C ${shellQuote(checkout.path)} read-tree ${shellQuote(`${preserved}^2`)}`
      console.warn(
        `CONDITION: landing succeeded, but checkout ${checkout.path} could not be reconciled because it holds tracked work:\n` +
        `${detail}\n${error instanceof Error ? error.message : String(error)}\n` +
        `Its working tree was left unchanged and its index now matches ${trunk} at ${tip}.\n` +
        `The previous index is preserved at ${ref} (${preserved}).\n` +
        `Recover that exact index with:\n${command}\n` +
        `Review and reconcile this checkout before using or committing it.`,
      )
    }
  }
}

function runGate(
  project: Project, worktree: string, branch: string, guard: SharedRefGuardEnvironment,
): string {
  const gate = typeof project.settings.gate === 'string' ? project.settings.gate.trim() : ''
  if (!gate) {
    throw new Error(
      `project ${project.name} has no landing gate configured — set settings.gate before landing`,
    )
  }
  const before = git(worktree, ['status', '--porcelain=v1', '--untracked-files=all'], guard)
  if (before) {
    throw new Error(`refusing to gate a dirty worktree for ${project.name}:\n${before}`)
  }
  type ReflogEntry = { oldOid: string; newOid: string; message: string }
  const reflogEntries = (ref: string): ReflogEntry[] => {
    const path = git(worktree, [
      'rev-parse', '--path-format=absolute', '--git-path', `logs/${ref}`,
    ], guard)
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t')
      const [oldOid, newOid] = (tab === -1 ? line : line.slice(0, tab)).split(' ', 2)
      return { oldOid: oldOid!, newOid: newOid!, message: tab === -1 ? '' : line.slice(tab + 1) }
    })
  }
  const reflogKey = (entry: ReflogEntry) =>
    `${entry.oldOid}\0${entry.newOid}\0${entry.message}`
  const unmatchedReflogEntries = (entries: ReflogEntry[], captured: ReflogEntry[]) => {
    const remaining = new Map<string, number>()
    for (const entry of captured) {
      const key = reflogKey(entry)
      remaining.set(key, (remaining.get(key) ?? 0) + 1)
    }
    return entries.filter((entry) => {
      const key = reflogKey(entry)
      const count = remaining.get(key) ?? 0
      if (count === 0) return true
      remaining.set(key, count - 1)
      return false
    })
  }
  const tip = git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'], guard)
  const headReflogBefore = reflogEntries('HEAD')
  const branchRef = `refs/heads/${branch}`
  const branchReflogBefore = reflogEntries(branchRef)
  const contentBefore = contentTree(worktree)
  console.log(`gate ${project.name}: ${gate}`)
  const captureSetup = prepareGateCapture(project.name)
  const truncatedMarker = captureSetup.ok
    ? join(captureSetup.paths.directory, 'truncated')
    : null
  const capture = [
    'tee "$3" <"$2" & output_tee=$!',
    'sh -lc "$1" >"$2" 2>&1; status=$?',
    'attempts=0',
    'while [ "$attempts" -lt 50 ] && kill -0 "$output_tee" 2>/dev/null; do',
    '  sleep 0.1',
    '  attempts=$((attempts + 1))',
    'done',
    'if kill -0 "$output_tee" 2>/dev/null; then',
    '  : > "$4" 2>/dev/null || true',
    '  kill -9 "$output_tee" 2>/dev/null',
    'fi',
    'wait "$output_tee" 2>/dev/null || true',
    'exit "$status"',
  ].join('\n')
  const spawnOptions = {
    cwd: worktree, env: { ...process.env, ...guard }, stdout: 'inherit' as const,
    stderr: 'inherit' as const,
  }
  const p = !captureSetup.ok
    ? Bun.spawnSync(['sh', '-lc', gate], spawnOptions)
    : Bun.spawnSync([
        'sh', '-c', capture, 'orch-gate-capture', gate,
        captureSetup.pipe, captureSetup.paths.output, truncatedMarker!,
      ], spawnOptions)
  let capturedOutput: string | null = null
  let captureReadError: string | null = null
  let captureTruncated = false
  if (captureSetup.ok) {
    try {
      captureTruncated = existsSync(truncatedMarker!)
      if (p.exitCode !== 0) capturedOutput = readFileSync(captureSetup.paths.output, 'utf8')
    } catch (error) {
      captureReadError = error instanceof Error ? error.message : String(error)
    } finally {
      rmSync(captureSetup.pipe, { force: true })
      rmSync(truncatedMarker!, { force: true })
    }
  }
  if (p.exitCode !== 0) {
    if (!captureSetup.ok) {
      throw new Error(
        `landing gate failed with exit ${p.exitCode}: ${gate}\n` +
        `gate output not captured: ${captureSetup.error}`,
      )
    }
    if (captureReadError || capturedOutput === null) {
      rmSync(captureSetup.paths.directory, { recursive: true, force: true })
      throw new Error(
        `landing gate failed with exit ${p.exitCode}: ${gate}\n` +
        `gate output not captured: ${captureReadError ?? 'capture log was unavailable'}`,
      )
    }
    throw new Error(
      `landing gate failed with exit ${p.exitCode}: ${gate}\n` +
      gateFailureSummary(
        capturedOutput, captureSetup.paths.output, liveRunCount(), captureTruncated,
      ),
    )
  }
  if (captureSetup.ok) rmSync(captureSetup.paths.directory, { recursive: true, force: true })
  const headAfter = git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'], guard)
  if (headAfter !== tip) {
    throw new Error(
      `refusing landing because gate ${gate} moved HEAD from ${tip} to ${headAfter}`,
    )
  }
  const branchAfter = git(worktree, [
    'rev-parse', '--verify', `${branchRef}^{commit}`,
  ], guard)
  if (branchAfter !== tip) {
    throw new Error(
      `refusing landing because gate ${gate} moved ${branchRef} from ${tip} to ${branchAfter}`,
    )
  }
  const reflogChanges = (ref: string, captured: ReflogEntry[]) => {
    const after = reflogEntries(ref)
    const added = unmatchedReflogEntries(after, captured).filter((entry) =>
      entry.oldOid !== tip || entry.newOid !== tip)
    const missing = unmatchedReflogEntries(captured, after)
    return { ref, added, missing }
  }
  const reflogs = [
    reflogChanges('HEAD', headReflogBefore),
    reflogChanges(branchRef, branchReflogBefore),
  ]
  if (reflogs.some(({ added, missing }) => added.length || missing.length)) {
    const render = (entry: ReflogEntry) =>
      `${entry.oldOid} -> ${entry.newOid}${entry.message ? ` ${entry.message}` : ''}`
    throw new Error(
      `refusing landing because gate ${gate} changed git history:\n` +
      reflogs.filter(({ added, missing }) => added.length || missing.length).map(
        ({ ref, added, missing }) => `${ref} reflog:\n` +
          (added.length ? `  added:\n${added.map(render).join('\n')}\n` : '') +
          (missing.length ? `  missing:\n${missing.map(render).join('\n')}\n` : ''),
      ).join(''),
    )
  }
  const contentAfter = contentTree(worktree)
  // This observes final bytes only; a gate that restores them exactly requires continuous observation.
  if (contentAfter !== contentBefore) {
    throw new Error(
      `refusing landing because gate ${gate} changed the content tree from ${contentBefore} to ${contentAfter}`,
    )
  }
  const after = git(worktree, ['status', '--porcelain=v1', '--untracked-files=all'], guard)
  if (after) {
    throw new Error(`landing gate changed the worktree; its result was not the commit being landed:\n${after}`)
  }
  return tip
}

function trunkCommit(repoRoot: string, trunk: string, guard?: SharedRefGuardEnvironment): string {
  return git(repoRoot, ['rev-parse', '--verify', `refs/heads/${trunk}^{commit}`], guard)
}

function amendLandingMessage(
  worktree: string, message: string, guard: SharedRefGuardEnvironment,
): void {
  if (message.trim() === '') throw new Error('landing message is empty')
  const dirty = git(worktree, ['status', '--porcelain=v1', '--untracked-files=all'], guard)
  if (dirty) throw new Error(`refusing to amend a dirty worktree:\n${dirty}`)
  git(worktree, ['commit', '--amend', '-m', message], guard)
}

function rebaseAndGate(
  project: Project, repoRoot: string, worktree: string, branch: string, trunk: string,
  trunkOid: string, guard: SharedRefGuardEnvironment,
): string {
  console.log(`rebase ${branch} onto ${trunk} at ${trunkOid}`)
  git(worktree, ['rebase', trunkOid], guard)
  const tip = git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'], guard)
  if (tip === trunkOid) throw new Error(`branch ${branch} has no commits to land after rebasing onto ${trunk}`)
  return runGate(project, worktree, branch, guard)
}

export type ReviewCoverageInput = {
  id: number
  lenses: {
    lens: string
    runId: number
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
    `SELECT r.id, rl.lens, rl.run_id, rl.reviewed_tree, run.input_tree,
            run.branch, run.base_commit, run.launch_cwd, run.head_commit
       FROM review r
       JOIN review_lens rl ON rl.review_id=r.id
       JOIN run ON run.id=rl.run_id
      WHERE r.completed_at IS NOT NULL AND EXISTS (
        SELECT 1 FROM review_lens project_lens
        JOIN run project_run ON project_run.id=project_lens.run_id
        WHERE project_lens.review_id=r.id AND project_run.repo=?
      )
      ORDER BY r.id, rl.id`,
  ).all(project) as {
    id: number; lens: string; run_id: number; reviewed_tree: string | null
    input_tree: string | null; branch: string | null; base_commit: string | null
    launch_cwd: string | null; head_commit: string | null
  }[]
  const grouped = new Map<number, ReviewCoverageInput>()
  for (const row of rows) {
    const review = grouped.get(row.id) ?? { id: row.id, lenses: [] }
    review.lenses.push({
      lens: row.lens, runId: row.run_id, tree: row.reviewed_tree,
      inputTree: row.input_tree, branch: row.branch, baseCommit: row.base_commit,
      launchCwd: row.launch_cwd, headCommit: row.head_commit,
    })
    grouped.set(row.id, review)
  }
  return [...grouped.values()]
}

type ReviewCarry = {
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
  | ({ kind: 'carried'; resolution: 'pin' | 'walk' } & Omit<ReviewCarry, 'project' | 'branch'>)
  | { kind: 'invalid'; reason: string; resolution?: 'pin' | 'walk' }

export type CoverageGitResult = { ok: boolean; out: string; err: string; stdout: Uint8Array }
export type CoverageGitRunner = (args: string[], stdin?: Uint8Array) => CoverageGitResult

function landingCoverageGit(repoRoot: string): CoverageGitRunner {
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

function patchId(runner: CoverageGitRunner, from: string, to: string): string {
  const diff = runner(['diff', `${from}..${to}`])
  if (!diff.ok) throw new Error(`git diff ${from}..${to} failed: ${diff.err}`)
  const id = runner(['patch-id', '--stable'], diff.stdout)
  if (!id.ok) throw new Error(`git patch-id --stable failed: ${id.err}`)
  return id.out.split(/\s+/)[0] ?? ''
}

function contentHash(runner: CoverageGitRunner, from: string, to: string): string {
  const diff = runner(['diff', '--no-color', '--no-ext-diff', '-U0', '--no-renames', `${from}..${to}`])
  if (!diff.ok) throw new Error(`git diff ${from}..${to} failed: ${diff.err}`)
  const canonical = new TextDecoder().decode(diff.stdout).split('\n')
    .filter((line) => !line.startsWith('index ')).join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}

function changedPaths(runner: CoverageGitRunner, from: string, to: string): Set<string> {
  const args = ['diff', '--name-only', `${from}..${to}`]
  const output = coverageOutput(runner(args), args)
  return new Set(output ? output.split('\n') : [])
}

export function reviewCoverageVerdict(
  repoRoot: string, review: ReviewCoverageInput, tip: string, trunk: string,
  runner: CoverageGitRunner = landingCoverageGit(repoRoot),
): CoverageVerdict {
  const treeArgs = ['rev-parse', `${tip}^{tree}`]
  const treeResult = runner(treeArgs)
  if (!treeResult.ok) return { kind: 'invalid', reason: `git ${treeArgs.join(' ')} failed: ${treeResult.err}` }
  const tree = treeResult.out
  if (review.lenses.length > 0 && review.lenses.every((lens) => lens.tree === tree)) {
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
  const trunkPaths = changedPaths(runner, oldBase, newBase)
  const overlap = [...changePaths].filter((path) => trunkPaths.has(path))
  if (overlap.length) return { kind: 'invalid', reason: 'overlapping paths', resolution: resolved.resolution }
  const reviewedPatch = patchId(runner, oldBase, reviewedCommit)
  const candidatePatch = patchId(runner, newBase, tip)
  if (!reviewedPatch || reviewedPatch !== candidatePatch) {
    return { kind: 'invalid', reason: 'patch-id differs', resolution: resolved.resolution }
  }
  if (contentHash(runner, oldBase, reviewedCommit) !== contentHash(runner, newBase, tip)) {
    return { kind: 'invalid', reason: 'content differs', resolution: resolved.resolution }
  }
  return {
    kind: 'carried', resolution: resolved.resolution, tip, tree, reviewId: review.id, reviewedCommit, reviewedTree,
    patchId: candidatePatch, oldBase, newBase,
  }
}

function coverageText(project: string, repoRoot: string, tip: string, trunk: string): string {
  const candidateTree = git(repoRoot, ['rev-parse', `${tip}^{tree}`])
  const reviews = completedReviews(project)
  const lines = reviews.length
    ? reviews.map((review) => {
        const verdict = reviewCoverageVerdict(repoRoot, review, tip, trunk)
        if (verdict.kind === 'exact') return `review ${review.id}: exact`
        if (verdict.kind === 'carried') {
          return `review ${review.id}: carried (patch-id ${verdict.patchId}; ` +
            `${verdict.oldBase}..${verdict.newBase}) (commit from ${verdict.resolution})`
        }
        return `review ${review.id}: invalid (${verdict.reason}) ` +
          `(commit from ${verdict.resolution ?? 'not resolved'})`
      })
    : ['  none']
  return `current tip tree: ${candidateTree}\n${lines.join('\n')}`
}

function requireReviewCoverage(
  project: Project, repoRoot: string, branch: string, tip: string, trunk: string,
): { tree: string; carry: ReviewCarry | null } {
  const candidateTree = git(repoRoot, ['rev-parse', `${tip}^{tree}`])
  const reviews = completedReviews(project.name)
  if (reviews.some((review) => review.lenses.length > 0 &&
      review.lenses.every((lens) => lens.tree === candidateTree))) {
    return { tree: candidateTree, carry: null }
  }
  const verdicts = reviews.map((review) => ({ review, verdict: reviewCoverageVerdict(repoRoot, review, tip, trunk) }))
  const carried = verdicts.find((item) => item.verdict.kind === 'carried')
  if (carried?.verdict.kind === 'carried') {
    return {
      tree: candidateTree,
      carry: { project: project.name, branch, ...carried.verdict },
    }
  }
  throw new Error(
    `refusing to land unreviewed content\ncandidate tree: ${candidateTree}\n` +
    `${coverageText(project.name, repoRoot, tip, trunk)}\n` +
    'A rebase onto moved trunk changes the tree, so re-run the review lenses from the rebased branch ' +
    '(with --carry) and record them.',
  )
}

function authorizeLanding(
  project: Project, repoRoot: string, branch: string, tip: string, trunk: string, unreviewed?: string,
): {
  override: { project: string; branch: string; tip: string; tree: string; reason: string } | null
  carry: ReviewCarry | null
} {
  const escaped = db().query(
    `SELECT escaped.id
       FROM run escaped
      WHERE escaped.failure_kind='escaped'
        AND (escaped.branch=? OR escaped.parent_run_id IN (
          SELECT root.id FROM run root WHERE root.branch=? AND root.parent_run_id IS NULL
        ))
      ORDER BY escaped.id LIMIT 1`,
  ).get(branch, branch) as { id: number } | null
  if (escaped) {
    throw new Error(
      `refusing to land ${branch}: run ${escaped.id} violated the invariant ` +
      "A WORKER'S WRITES OUTSIDE ITS TREE FAIL THE RUN; --unreviewed cannot override it",
    )
  }
  const reason = unreviewed?.trim()
  if (unreviewed !== undefined && !reason) throw new Error('--unreviewed requires a non-empty reason')
  if (reason) {
    const tree = git(repoRoot, ['rev-parse', `${tip}^{tree}`])
    console.error(
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' +
      'UNREVIEWED LANDING OVERRIDE\n' +
      `Trunk is receiving unreviewed content from ${branch}.\n` +
      `tree: ${tree}\nreason: ${reason}\n` +
      '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
    )
    return { override: { project: project.name, branch, tip, tree, reason }, carry: null }
  }
  const coverage = requireReviewCoverage(project, repoRoot, branch, tip, trunk)
  return { override: null, carry: coverage.carry }
}

function recordLandingOverride(
  override: { project: string; branch: string; tip: string; tree: string; reason: string } | null,
): void {
  if (!override) return
  db().query(
    `INSERT INTO landing_override (project, branch, tip, tree, reason, session_id, at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    override.project, override.branch, override.tip, override.tree, override.reason,
    sessionId(), nowIso(),
  )
}

function recordReviewCarry(carry: ReviewCarry | null): void {
  if (!carry) return
  db().query(
    `INSERT INTO landing_review_carry
       (project,branch,tip,tree,review_id,reviewed_commit,reviewed_tree,patch_id,
        old_base,new_base,session_id,at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    carry.project, carry.branch, carry.tip, carry.tree, carry.reviewId,
    carry.reviewedCommit, carry.reviewedTree, carry.patchId, carry.oldBase, carry.newBase,
    sessionId(), nowIso(),
  )
  console.log(
    `review ${carry.reviewId} carried: patch-id ${carry.patchId} unchanged across rebase ` +
    `${carry.oldBase}..${carry.newBase}; gate green on ${carry.tip}`,
  )
}

function fastForward(
  repoRoot: string, worktree: string, branch: string, trunk: string, tip: string, expected: string,
  guard: SharedRefGuardEnvironment,
): void {
  if (!gitOk(repoRoot, ['merge-base', '--is-ancestor', expected, tip], guard)) {
    throw new Error(`refusing to land ${branch}: ${tip} is not a fast-forward of ${trunk} at ${expected}`)
  }
  // The expected old value makes the ref update itself the lost-race check.
  // The reference-transaction guard installed in this worktree runs before it
  // and refuses any commit not reachable from the common object database.
  const trunkCheckouts = worktreesForBranch(repoRoot, trunk)
    .map((path) => checkoutState(path, expected))
  // A tracked checkout may need its old index after HEAD moves. Prove that Git
  // can capture it before advancing trunk; preservation failure leaves both
  // trunk and the checkout untouched.
  for (const checkout of trunkCheckouts) {
    if (checkout.trackedWork) checkout.preservedIndex = preserveIndex(checkout, guard)
  }
  git(worktree, [
    'update-ref', `refs/heads/${trunk}`, tip, expected,
  ], guard)
  reconcileTrunkCheckouts(trunkCheckouts, trunk, tip, expected, guard)
}

export function land(
  cwd: string,
  branch: string,
  options: { timeoutMs?: number; message?: string; unreviewed?: string } = {},
): string {
  writableDb()
  const timeoutMs = options.timeoutMs ?? LANDING_LOCK_TIMEOUT_MS
  const { project, repoRoot } = registeredProject(cwd)
  const trunk = typeof project.settings.trunk === 'string' ? project.settings.trunk.trim() : ''
  if (!trunk) throw new Error(`project ${project.name} has no trunk configured — set settings.trunk before landing`)
  const gate = typeof project.settings.gate === 'string' ? project.settings.gate.trim() : ''
  if (!gate) throw new Error(`project ${project.name} has no landing gate configured — set settings.gate before landing`)
  if (!gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
    throw new Error(`branch ${branch} does not exist in project ${project.name}`)
  }
  if (!gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${trunk}`])) {
    throw new Error(`configured trunk ${trunk} does not exist in project ${project.name}`)
  }
  const worktree = worktreesForBranch(repoRoot, branch)[0] ?? null
  if (!worktree || !existsSync(worktree)) throw new Error(`branch ${branch} has no worktree and cannot be landed`)
  if (branch === trunk || gitOk(repoRoot, [
    'merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${trunk}`,
  ])) {
    throw new Error(`branch ${branch} is already merged into ${trunk}`)
  }

  const guard = prepareSharedRefGuard(worktree)
  // A message-only amend changes the commit hash. The gate must run on the
  // commit that becomes trunk, so the message is rewritten before rebase.
  if (options.message !== undefined) amendLandingMessage(worktree, options.message, guard)
  const recordedTrunk = trunkCommit(repoRoot, trunk, guard)
  const optimisticTip = rebaseAndGate(
    project, repoRoot, worktree, branch, trunk, recordedTrunk, guard,
  )

  return withProjectLock(repoRoot, LANDING_LOCK, { session: sessionId(), what: branch }, () => {
    const currentTrunk = trunkCommit(repoRoot, trunk, guard)
    if (currentTrunk === recordedTrunk) {
      const authorization = authorizeLanding(
        project, repoRoot, branch, optimisticTip, recordedTrunk, options.unreviewed,
      )
      fastForward(repoRoot, worktree, branch, trunk, optimisticTip, recordedTrunk, guard)
      recordLandingOverride(authorization.override)
      recordReviewCarry(authorization.carry)
      console.log(`landed ${branch} at ${optimisticTip} onto ${trunk} (optimistic gate remained current)`)
      return optimisticTip
    }

    console.log(`${trunk} moved from ${recordedTrunk} to ${currentTrunk}; re-gating ${branch} under the landing lock`)
    const serializedTip = rebaseAndGate(
      project, repoRoot, worktree, branch, trunk, currentTrunk, guard,
    )
    const authorization = authorizeLanding(
      project, repoRoot, branch, serializedTip, currentTrunk, options.unreviewed,
    )
    fastForward(repoRoot, worktree, branch, trunk, serializedTip, currentTrunk, guard)
    recordLandingOverride(authorization.override)
    recordReviewCarry(authorization.carry)
    console.log(`landed ${branch} at ${serializedTip} onto ${trunk} after serialized re-gate`)
    return serializedTip
  }, timeoutMs, true)
}

export function landingStatus(cwd: string): string {
  const { project, repoRoot } = registeredProject(cwd)
  const state = projectLockState(repoRoot, LANDING_LOCK)
  const age = (since: string) => `${Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000))}s`
  const holder = state.holder
    ? `held by session ${state.holder.session ?? 'unknown'}, pid ${state.holder.pid}, ` +
      `landing ${state.holder.what}, for ${age(state.holder.since)}`
    : 'free'
  const waiters = state.waiters.length
    ? state.waiters.map((w) =>
        `  session ${w.session ?? 'unknown'}, pid ${w.pid}, landing ${w.what}, waiting ${age(w.since)}`).join('\n')
    : '  none'
  const branch = git(cwd, ['branch', '--show-current']) || '(detached)'
  const tip = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const trunk = typeof project.settings.trunk === 'string' ? project.settings.trunk.trim() : ''
  return `${project.name} landing lock: ${holder}\nwaiters:\n${waiters}\n${formatGitLocks(repoRoot)}` +
    `\nreview coverage for ${branch}:\n${coverageText(project.name, repoRoot, tip, trunk)}`
}
