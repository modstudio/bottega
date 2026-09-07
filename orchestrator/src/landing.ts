import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { db, liveRunCount, migrateDatabase, nowIso, sessionId, tryWriteContention, writableDb, writeTransaction, ROOT } from './db.ts'
import { reviewInvalidationsSince } from './contention.ts'
import { projectAt, projectByName, type Project } from './projects.ts'
import { classifyReviewTier, diffNumstat } from './review-tier.ts'
import {
  contentTree, prepareSharedRefGuard, projectLockState, repoRootOf, withProjectLock,
  withWorktreeLease, targetGitEnvironment, scrubbedGitEnv, type SharedRefGuardEnvironment,
} from './worktree.ts'

const LANDING_LOCK = 'landing'
const LANDING_LOCK_TIMEOUT_MS = 5 * 60_000
const GATE_FAILURE_TAIL_LINES = 40
const INVARIANT_FAILED_LANDING = 'A failed landing leaves the branch worktree as it found it.'
const INVARIANT_LOCK_SCOPE =
  'Landing holds its lock only for the trunk re-check, guard verification and fast-forward, never for a gate.'
const INVARIANT_GUARD_HEAD =
  'The guard on disk is verified against HEAD, not the index, before any fast-forward.'
const INVARIANT_TRUNK_CHECKOUT =
  'The registered main checkout must have its symbolic HEAD on the configured trunk.'
export type SharedGuardResidue = {
  repoRoot: string
  hookPath: string
  relativePath: string
  repairCommand: string
}

function namedError(detail: string, invariant: string, command: string): Error {
  return new Error(`${detail}\ninvariant: ${invariant}\ncleared by: ${command}`)
}

function inspectionGit(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const env = scrubbedGitEnv()
  delete env.GIT_INDEX_FILE
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env, stdout: 'pipe', stderr: 'pipe',
  })
  return {
    ok: p.exitCode === 0,
    out: p.stdout.toString().trim(),
    err: p.stderr.toString().trim() || `exit ${p.exitCode}`,
  }
}

/** Detect damage to the tracked guard bytes by comparing with HEAD, never the index. */
export function sharedGuardResidue(root = ROOT): SharedGuardResidue | null {
  const hookPath = join(root, 'hooks', 'reference-transaction')
  const repoRoot = repoRootOf(root)
  if (!repoRoot || !existsSync(hookPath)) return null
  let from: string
  let to: string
  try {
    from = realpathSync(repoRoot)
    to = realpathSync(hookPath)
  } catch { return null }
  const relativePath = relative(from, to)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return null
  const worktree = inspectionGit(repoRoot, ['diff', '--quiet', 'HEAD', '--', relativePath])
  const staged = inspectionGit(repoRoot, ['diff', '--quiet', '--cached', 'HEAD', '--', relativePath])
  if (worktree.ok && staged.ok) return null
  return {
    repoRoot, hookPath, relativePath,
    repairCommand: `git -C ${shellQuote(repoRoot)} checkout HEAD -- ${shellQuote(relativePath)}`,
  }
}

/** Restore the guard from HEAD into both the worktree and the index. */
export function restoreSharedGuard(root = ROOT): SharedGuardResidue | null {
  const residue = sharedGuardResidue(root)
  if (!residue) return null
  const restored = inspectionGit(residue.repoRoot, ['checkout', 'HEAD', '--', residue.relativePath])
  if (!restored.ok) {
    throw namedError(
      `shared reference-transaction guard restore failed: ${restored.err}`,
      INVARIANT_GUARD_HEAD,
      residue.repairCommand,
    )
  }
  if (sharedGuardResidue(root)) {
    throw namedError(
      `shared reference-transaction guard still differs after: ${residue.repairCommand}`,
      INVARIANT_GUARD_HEAD,
      residue.repairCommand,
    )
  }
  console.log(`restored shared reference-transaction guard with: ${residue.repairCommand}`)
  return residue
}

function landingOrder(step: string): void {
  const log = process.env.ORCH_TEST_LANDING_ORDER
  if (!log) return
  writeFileSync(log, `${step}\n`, { flag: 'a' })
}

function verifyGuardBeforeFastForward(repoRoot: string): void {
  landingOrder('guard-verify')
  const roots = new Set<string>()
  for (const candidate of [join(repoRoot, 'orchestrator'), ROOT]) {
    try { roots.add(realpathSync(candidate)) } catch { /* no orchestrator dir in this repo */ }
  }
  for (const root of roots) {
    if (!sharedGuardResidue(root)) continue
    restoreSharedGuard(root)
    if (sharedGuardResidue(root)) {
      throw namedError(
        'shared reference-transaction guard differs from HEAD before fast-forward',
        INVARIANT_GUARD_HEAD,
        'git checkout HEAD -- orchestrator/hooks/reference-transaction',
      )
    }
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

const reporterBody = (line: string) => line.replace(
  /^\s*(?:\[[^\]]+\]\s*)+(?=(?:\(pass\)|\(fail\)|✓|✗|\d+\s+fail))/,
  '',
)
const failedTestLine = (line: string) => /^\s*(?:\(fail\)|✗)\s+/.test(reporterBody(line))
const testResultLine = (line: string) => /^\s*(?:\(pass\)|\(fail\)|✓|✗)\s+/.test(reporterBody(line))
const failureCountLine = (line: string) => /^\s*\d+\s+fail(?:s|ed)?\b/.test(reporterBody(line))
const testFileHeading = (line: string) =>
  /^\s*(?:\[[^\]]+\]\s*)?.+\.(?:test|spec)\.[cm]?[jt]sx?:\s*$/.test(line)
const shardHeading = (line: string) =>
  /^\s*(?:\[[^\]]+\]\s*)*\[?shard(?:\s+|:)[^\]]*\]?\s*$/i.test(line)

/** Preserve each failed test's reporter context and assertion frame wherever it sits in the log. */
function gateFailureLines(output: string): string[] {
  const lines = output.split('\n').map(stripAnsi)
  const blocks: string[] = []
  for (let failure = 0; failure < lines.length; failure++) {
    if (!failedTestLine(lines[failure]!)) continue
    let file = failure - 1
    while (file >= 0 && !testFileHeading(lines[file]!) && !shardHeading(lines[file]!)) file--
    let shard = file - 1
    while (shard >= 0 && !shardHeading(lines[shard]!)) shard--
    if (shard >= 0 && shardHeading(lines[shard]!)) blocks.push(lines[shard]!)
    if (file >= 0 && testFileHeading(lines[file]!)) blocks.push(lines[file]!)

    let start = failure
    while (start > file + 1 && !testResultLine(lines[start - 1]!)) start--
    let end = failure + 1
    while (end < lines.length && !testResultLine(lines[end]!) &&
      !testFileHeading(lines[end]!) && !shardHeading(lines[end]!) &&
      !failureCountLine(lines[end]!)) end++
    blocks.push(...lines.slice(start, end))
    blocks.push('')
  }
  const counts = lines.filter(failureCountLine)
  return blocks.length ? [...blocks, ...counts] : counts
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

function recordedLandingBlock(
  project: string, branch: string, runId?: number,
): { detail: string; invariant: string; command: string; worktree: string } | null {
  const rows = runId === undefined
    ? db().query(
        `SELECT member.pre_confinement FROM run member
          JOIN run root ON root.id=COALESCE(member.parent_run_id,member.id)
         WHERE root.repo=? AND root.branch=? ORDER BY root.id DESC,member.turn DESC,member.id DESC`,
      ).all(project, branch)
    : db().query(
        `SELECT pre_confinement FROM run
          WHERE id=COALESCE((SELECT parent_run_id FROM run WHERE id=?),?)
             OR parent_run_id=COALESCE((SELECT parent_run_id FROM run WHERE id=?),?)
          ORDER BY turn DESC,id DESC`,
      ).all(runId, runId, runId, runId)
  for (const row of rows as { pre_confinement: string | null }[]) {
    if (!row.pre_confinement) continue
    try {
      const parsed = JSON.parse(row.pre_confinement) as {
        landingBlock?: { detail?: string; invariant?: string; command?: string; worktree?: string }
      }
      const block = parsed.landingBlock
      if (!block?.detail || !block.invariant || !block.command || !block.worktree) continue
      return { detail: block.detail, invariant: block.invariant, command: block.command,
        worktree: block.worktree }
    } catch { /* malformed historical receipt cannot create a landing block */ }
  }
  return null
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

function assertMainCheckoutOnTrunk(repoRoot: string, trunk: string): void {
  const branch = inspectionGit(repoRoot, ['symbolic-ref', '--short', 'HEAD'])
  if (branch.ok && branch.out === trunk) return
  throw namedError(
    `refusing landing: registered main checkout ${repoRoot} is on ${branch.ok ? branch.out : '(detached HEAD)'}, not ${trunk}`,
    INVARIANT_TRUNK_CHECKOUT,
    `git -C ${shellQuote(repoRoot)} switch ${shellQuote(trunk)}`,
  )
}

function clearCompletedSequencerState(
  worktree: string, branch: string, guard: SharedRefGuardEnvironment,
): void {
  const gitPath = (name: string) => git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', name], guard)
  const states = [
    { name: 'CHERRY_PICK_HEAD', path: gitPath('CHERRY_PICK_HEAD'), quit: ['cherry-pick', '--quit'] },
    { name: 'REBASE_HEAD', path: gitPath('REBASE_HEAD'), quit: ['rebase', '--quit'] },
    { name: 'AUTO_MERGE', path: gitPath('AUTO_MERGE'), quit: null },
  ].filter((state) => existsSync(state.path))
  const unmerged = git(worktree, ['diff', '--name-only', '--diff-filter=U'], guard)
  if (unmerged) {
    throw namedError(
      `refusing to land ${branch}: unmerged paths remain:\n${unmerged}`,
      INVARIANT_FAILED_LANDING,
      `git -C ${shellQuote(worktree)} status`,
    )
  }
  if (!states.length) return
  const staged = !gitOk(worktree, ['diff', '--cached', '--quiet', 'HEAD'], guard)
  if (staged) return
  for (const state of states) {
    if (state.quit) git(worktree, state.quit, guard)
    else rmSync(state.path, { force: true })
    console.log(`quit completed ${state.name} state in ${worktree}`)
  }
}

function packageDependencies(source: string): Record<string, string> {
  try {
    const parsed = JSON.parse(source) as Record<string, unknown>
    return Object.assign({}, parsed.dependencies ?? {}, parsed.devDependencies ?? {}, parsed.optionalDependencies ?? {})
  } catch { return {} }
}

function preGateFacts(repoRoot: string, from: string, tip: string): string[] {
  const tier = classifyReviewTier({ files: diffNumstat(repoRoot, from, tip) })
  console.log(`tier ${tier.tier} (risk ${tier.risk}, size ${tier.size})`)
  for (const reason of tier.reasons) console.log(reason)
  const paths = git(repoRoot, ['diff', '--name-only', `${from}..${tip}`])
    .split('\n').filter((path) => path === 'package.json' || path.endsWith('/package.json'))
  const affected: string[] = []
  const delta: string[] = []
  for (const path of paths) {
    affected.push(dirname(path))
    const before = inspectionGit(repoRoot, ['show', `${from}:${path}`])
    const after = inspectionGit(repoRoot, ['show', `${tip}:${path}`])
    const left = packageDependencies(before.ok ? before.out : '{}')
    const right = packageDependencies(after.ok ? after.out : '{}')
    for (const name of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (left[name] !== right[name]) delta.push(`${path}: ${name} ${left[name] ?? '(absent)'} -> ${right[name] ?? '(absent)'}`)
    }
  }
  console.log(delta.length ? `dependency delta:\n${delta.map((line) => `  ${line}`).join('\n')}` : 'dependency delta: none')
  landingOrder('tier-and-dependencies')
  return [...new Set(affected)]
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
  landingOrder('gate')
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
  const gateStarted = Date.now()
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
    const timedOut = (capturedOutput ?? '').split('\n').some((line) =>
      /^\s*\^ this test timed out after \d+ms\.\s*$/.test(stripAnsi(line)))
    if (timedOut) {
      tryWriteContention({
        resourceKind: 'cpu', resourceKey: project.name, eventKind: 'timeout',
        durationMs: Math.max(0, Date.now() - gateStarted),
        cause: `gate timeout under load: ${liveRunCount()} orch runs live (running + asking) machine-wide`,
      })
    }
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

function rebaseInProgress(worktree: string, guard: SharedRefGuardEnvironment): boolean {
  const gitDir = git(worktree, ['rev-parse', '--path-format=absolute', '--git-dir'], guard)
  return existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))
}

function assertLandingWorktreeReady(
  worktree: string, branch: string, guard: SharedRefGuardEnvironment,
): void {
  if (rebaseInProgress(worktree, guard)) {
    throw namedError(
      `refusing to land ${branch}: a rebase is in progress in ${worktree}`,
      INVARIANT_FAILED_LANDING,
      `git -C ${shellQuote(worktree)} rebase --abort`,
    )
  }
  const dirty = git(worktree, ['status', '--porcelain=v1', '--untracked-files=no'], guard)
  if (dirty) {
    throw namedError(
      `refusing to land ${branch}: uncommitted tracked changes in ${worktree}`,
      INVARIANT_FAILED_LANDING,
      `git -C ${shellQuote(worktree)} stash`,
    )
  }
}

function rebaseAndGate(
  project: Project, repoRoot: string, worktree: string, branch: string, trunk: string,
  trunkOid: string, guard: SharedRefGuardEnvironment,
): string {
  assertLandingWorktreeReady(worktree, branch, guard)
  const headBefore = git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'], guard)
  const gitDir = git(worktree, ['rev-parse', '--path-format=absolute', '--git-dir'], guard)
  const indexPath = join(gitDir, 'index')
  const indexBackup = existsSync(indexPath) ? `${indexPath}.orch-pre-rebase-${process.pid}` : null
  if (indexBackup) copyFileSync(indexPath, indexBackup)
  const restore = (cause: unknown): Error => {
    const detail = cause instanceof Error ? cause.message : String(cause)
    try {
      if (rebaseInProgress(worktree, guard)) git(worktree, ['rebase', '--abort'], guard)
      try {
        const headNow = git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'], guard)
        if (headNow !== headBefore) git(worktree, ['reset', '--keep', headBefore], guard)
      } catch { /* a dirty post-gate tree still has its refs and tracked files restored below */ }
      git(worktree, ['checkout', headBefore, '--', '.'], guard)
      git(worktree, ['update-ref', `refs/heads/${branch}`, headBefore], guard)
      git(worktree, ['checkout', branch], guard)
      if (indexBackup && existsSync(indexBackup)) copyFileSync(indexBackup, indexPath)
    } catch (restoreError) {
      return namedError(
        `${detail}\nrestore after failed landing also failed: ` +
        `${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        INVARIANT_FAILED_LANDING,
        `git -C ${shellQuote(worktree)} reset --hard ${headBefore}`,
      )
    }
    return namedError(
      `${detail}\nrestored branch tip ${headBefore} and index to the pre-rebase state`,
      INVARIANT_FAILED_LANDING,
      `git -C ${shellQuote(worktree)} reset --hard ${headBefore}`,
    )
  }
  try {
    console.log(`rebase ${branch} onto ${trunk} at ${trunkOid}`)
    git(worktree, ['rebase', trunkOid], guard)
    const tip = git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'], guard)
    if (tip === trunkOid) {
      throw namedError(
        `branch ${branch} has no commits to land after rebasing onto ${trunk}`,
        INVARIANT_FAILED_LANDING,
        `git -C ${shellQuote(worktree)} rebase --abort`,
      )
    }
    preGateFacts(repoRoot, trunkOid, tip)
    try {
      return runGate(project, worktree, branch, guard)
    } catch (error) {
      throw restore(error)
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('invariant:')) {
      if (!error.message.includes(`restored branch tip ${headBefore}`)) throw restore(error)
      throw error
    }
    throw restore(error)
  } finally {
    if (indexBackup) rmSync(indexBackup, { force: true })
  }
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
  opts?: { skipExact?: boolean },
): CoverageVerdict {
  const treeArgs = ['rev-parse', `${tip}^{tree}`]
  const treeResult = runner(treeArgs)
  if (!treeResult.ok) return { kind: 'invalid', reason: `git ${treeArgs.join(' ')} failed: ${treeResult.err}` }
  const tree = treeResult.out
  if (!opts?.skipExact && review.lenses.length > 0 &&
      review.lenses.every((lens) => lens.tree === tree)) {
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
  landingOrder('coverage')
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
  throw namedError(
    `refusing to land unreviewed content\ncandidate tree: ${candidateTree}\n` +
    `${coverageText(project.name, repoRoot, tip, trunk)}\n` +
    'A rebase onto moved trunk changes the tree, so re-run the review lenses from the rebased branch ' +
    '(with --carry) and record them.',
    INVARIANT_LOCK_SCOPE,
    'orch do review-lens --carry',
  )
}

function authorizeLanding(
  project: Project, repoRoot: string, worktree: string, branch: string, tip: string, trunk: string,
  runId?: number, unreviewed?: string,
): {
  override: { project: string; branch: string; tip: string; tree: string; reason: string } | null
  carry: ReviewCarry | null
} {
  let rootId: number | null
  if (runId !== undefined) {
    const selected = db().query(
      'SELECT COALESCE(parent_run_id, id) AS root_id FROM run WHERE id=?',
    ).get(runId) as { root_id: number } | null
    if (!selected) throw new Error(`no run ${runId}`)
    rootId = selected.root_id
  } else {
    const recorded = db().query(
      `SELECT id, worktree FROM run
        WHERE parent_run_id IS NULL AND repo=? AND branch=?
          AND (worktree IS NOT NULL OR branch_kept=?)
        ORDER BY id DESC`,
    ).all(project.name, branch, branch) as { id: number; worktree: string | null }[]
    // Both spellings are canonicalised: a recorded /var/... against porcelain's
    // /private/var/... refused the unique current owner (lens run 2290).
    const realOrNull = (path: string): string | null => {
      try { return realpathSync(path) } catch { return null }
    }
    const landingReal = realOrNull(worktree)
    const owners = recorded.filter((candidate) => {
      if (!candidate.worktree || landingReal === null) return false
      if (realOrNull(candidate.worktree) !== landingReal) return false
      try {
        return git(candidate.worktree, ['rev-parse', '--verify', 'HEAD^{commit}']) === tip
      } catch {
        return false
      }
    })
    if (recorded.length && owners.length !== 1) {
      throw new Error(
        `cannot resolve the owning chain of ${branch} (runs ${recorded.map((row) => row.id).join(', ')}); ` +
        'orch land <run id>, or discard the stale chains',
      )
    }
    rootId = owners[0]?.id ?? null
  }
  const unsafe = rootId === null ? null : db().query(
    `SELECT id, failure_kind FROM run
      WHERE (id=? OR parent_run_id=?)
        AND failure_kind IN ('escaped', 'confinement_unverified')
      ORDER BY turn, id LIMIT 1`,
  ).get(rootId, rootId) as { id: number; failure_kind: string } | null
  if (unsafe) {
    throw new Error(
      `refusing to land ${branch}: run ${unsafe.id} is ${unsafe.failure_kind}; ` +
      'a persistent outside-checkout change or an unverifiable confinement check blocks ' +
      'this chain from landing, and --unreviewed cannot override it',
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
    `INSERT INTO landing_override (project, project_id, branch, tip, tree, reason, session_id, at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    override.project, projectByName(override.project)?.id ?? null, override.branch, override.tip, override.tree, override.reason,
    sessionId(), nowIso(),
  )
}

function recordReviewCarry(carry: ReviewCarry | null): void {
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

function recordReviewInvalidations(
  project: Project, repoRoot: string, trunkOid: string, landedBranch: string, landingId: number,
): void {
  for (const review of completedReviews(project.name)) {
    const branch = review.lenses.find((lens) => lens.branch)?.branch
    if (!branch || branch === landedBranch) continue
    try {
      const gitCwd = review.lenses.find((lens) => lens.launchCwd)?.launchCwd ?? repoRoot
      if (!gitOk(gitCwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) continue
      const runner = landingCoverageGit(gitCwd)
      const victimTip = git(gitCwd, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
      // Replay onto the new trunk so merge-base(tip, trunk) is the landed tip and
      // patch-id/content compare the replay, not the unrebased tree. skipExact is
      // required: the unrebased victim tree still matches the review.
      const merge = runner(['merge-tree', '--write-tree', trunkOid, victimTip])
      const mergeTree = merge.out.split('\n')[0]?.trim() ?? ''
      const tree = /^[0-9a-f]{40,}$/i.test(mergeTree)
        ? mergeTree
        : git(gitCwd, ['rev-parse', `${victimTip}^{tree}`])
      const synthetic = git(gitCwd, [
        'commit-tree', tree, '-p', trunkOid, '-m', 'orch-contention-coverage',
      ])
      const verdict = reviewCoverageVerdict(
        gitCwd, review, synthetic, trunkOid, runner, { skipExact: true },
      )
      if (verdict.kind !== 'invalid') continue
      tryWriteContention({
        resourceKind: 'review', resourceKey: branch, eventKind: 'invalidation',
        cause: `review ${review.id}`, landingId,
      })
    } catch { /* a missing path or tree is not this landing's invalidation */ }
  }
}

function fastForward(
  repoRoot: string, worktree: string, branch: string, trunk: string, tip: string, expected: string,
  guard: SharedRefGuardEnvironment,
): void {
  if (!gitOk(repoRoot, ['merge-base', '--is-ancestor', expected, tip], guard)) {
    throw namedError(
      `refusing to land ${branch}: ${tip} is not a fast-forward of ${trunk} at ${expected}`,
      INVARIANT_LOCK_SCOPE,
      `orch land ${branch}`,
    )
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
  landingOrder('fast-forward')
  git(worktree, [
    'update-ref', `refs/heads/${trunk}`, tip, expected,
  ], guard)
  reconcileTrunkCheckouts(trunkCheckouts, trunk, tip, expected, guard)
}

function performLand(
  cwd: string,
  branch: string,
  options: {
    timeoutMs?: number; message?: string; unreviewed?: string; runId?: number
    queue?: boolean; landingId?: number
  } = {},
): { tip: string; trunkBefore: string; project: Project; repoRoot: string } {
  writableDb()
  const timeoutMs = options.timeoutMs ?? LANDING_LOCK_TIMEOUT_MS
  const { project, repoRoot } = registeredProject(cwd)
  const trunk = typeof project.settings.trunk === 'string' ? project.settings.trunk.trim() : ''
  if (!trunk) {
    throw namedError(
      `project ${project.name} has no trunk configured — set settings.trunk before landing`,
      INVARIANT_LOCK_SCOPE,
      `orch project set ${project.name} --settings '{"trunk":"<branch>"}'`,
    )
  }
  const gate = typeof project.settings.gate === 'string' ? project.settings.gate.trim() : ''
  if (!gate) {
    throw namedError(
      `project ${project.name} has no landing gate configured — set settings.gate before landing`,
      INVARIANT_LOCK_SCOPE,
      `orch project set ${project.name} --settings '{"gate":"<command>"}'`,
    )
  }
  const existingLanding = projectLockState(repoRoot, LANDING_LOCK).holder
  if (existingLanding && existingLanding.session && existingLanding.session === sessionId() && !options.queue) {
    throw namedError(
      `your own landing ${existingLanding.pid}, branch ${existingLanding.what}, started ${existingLanding.since}`,
      'A session does not wait invisibly on its own landing.',
      `wait for pid ${existingLanding.pid}, or pass --queue for a bounded visible wait`,
    )
  }
  if (!gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
    throw namedError(
      `branch ${branch} does not exist in project ${project.name}`,
      INVARIANT_LOCK_SCOPE,
      `git show-ref --verify refs/heads/${branch}`,
    )
  }
  if (!gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${trunk}`])) {
    throw namedError(
      `configured trunk ${trunk} does not exist in project ${project.name}`,
      INVARIANT_LOCK_SCOPE,
      `git show-ref --verify refs/heads/${trunk}`,
    )
  }
  const worktree = worktreesForBranch(repoRoot, branch)[0] ?? null
  if (!worktree || !existsSync(worktree)) {
    const recordedBlock = recordedLandingBlock(project.name, branch, options.runId)
    if (recordedBlock && !existsSync(recordedBlock.worktree)) {
      throw namedError(
        `refusing to land ${branch}: ${recordedBlock.detail}`,
        recordedBlock.invariant,
        recordedBlock.command,
      )
    }
    throw namedError(
      `branch ${branch} has no worktree and cannot be landed`,
      INVARIANT_LOCK_SCOPE,
      `git worktree add .claude/worktrees/${branch} ${branch}`,
    )
  }
  if (branch === trunk || gitOk(repoRoot, [
    'merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${trunk}`,
  ])) {
    throw namedError(
      `branch ${branch} is already merged into ${trunk}`,
      INVARIANT_LOCK_SCOPE,
      `git merge-base --is-ancestor refs/heads/${branch} refs/heads/${trunk}`,
    )
  }

  return withWorktreeLease(repoRoot, worktree, { session: sessionId(), what: `land ${branch}` }, () => {
    const guard = prepareSharedRefGuard(worktree)
    clearCompletedSequencerState(worktree, branch, guard)
    assertLandingWorktreeReady(worktree, branch, guard)
    assertMainCheckoutOnTrunk(repoRoot, trunk)
    landingOrder('preflight')
    // A message-only amend changes the commit hash. The gate must run on the
    // commit that becomes trunk, so the message is rewritten before rebase.
    if (options.message !== undefined) amendLandingMessage(worktree, options.message, guard)
    const recordedTrunk = trunkCommit(repoRoot, trunk, guard)
    if (options.unreviewed === undefined) {
      authorizeLanding(
        project, repoRoot, worktree, branch,
        git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'], guard), recordedTrunk,
        options.runId, options.unreviewed,
      )
    }
    let gatedTrunk = recordedTrunk
    let tip = rebaseAndGate(
      project, repoRoot, worktree, branch, trunk, recordedTrunk, guard,
    )
    let losses = 0
    while (true) {
      const outcome = withProjectLock(repoRoot, LANDING_LOCK, { session: sessionId(), what: branch }, () => {
        verifyGuardBeforeFastForward(repoRoot)
        assertMainCheckoutOnTrunk(repoRoot, trunk)
        const currentTrunk = trunkCommit(repoRoot, trunk, guard)
        if (currentTrunk === gatedTrunk) {
          const authorization = authorizeLanding(
            project, repoRoot, worktree, branch, tip, gatedTrunk,
            options.runId, options.unreviewed,
          )
          fastForward(repoRoot, worktree, branch, trunk, tip, gatedTrunk, guard)
          recordLandingOverride(authorization.override)
          recordReviewCarry(authorization.carry)
          return { kind: 'landed' as const, tip, currentTrunk }
        }
        return { kind: 'moved' as const, tip, currentTrunk }
      }, timeoutMs, true, options.queue ? (holder, remainingMs) => {
        console.log(
          `queued behind landing ${holder?.pid ?? 'unknown'}, branch ${holder?.what ?? 'unknown'}; ` +
          `${Math.ceil(remainingMs / 1000)}s remain`,
        )
      } : undefined)
      if (outcome.kind === 'landed') {
        const how = losses === 0
          ? 'optimistic gate remained current'
          : 'after re-gate outside the landing lock'
        console.log(`landed ${branch} at ${outcome.tip} onto ${trunk} (${how})`)
        return { tip: outcome.tip, trunkBefore: outcome.currentTrunk, project, repoRoot }
      }
      losses += 1
      tryWriteContention({
        resourceKind: 'trunk', resourceKey: project.name, eventKind: 'retry',
        cause: `${trunk} moved from ${gatedTrunk} to ${outcome.currentTrunk}`,
        landingId: options.landingId ?? null,
      })
      if (losses >= 2) {
        throw namedError(
          `refusing to land ${branch}: ${trunk} moved again to ${outcome.currentTrunk} after re-gate`,
          INVARIANT_LOCK_SCOPE,
          `orch land ${branch}`,
        )
      }
      console.log(
        `${trunk} moved from ${gatedTrunk} to ${outcome.currentTrunk}; re-gating ${branch} outside the landing lock`,
      )
      gatedTrunk = outcome.currentTrunk
      tip = rebaseAndGate(project, repoRoot, worktree, branch, trunk, gatedTrunk, guard)
    }
  }, timeoutMs)
}

export function diffCarriesMigrationJournal(paths: string[]): boolean {
  return paths.some((path) =>
    path === 'orchestrator/migrations' || path.startsWith('orchestrator/migrations/') ||
    path === 'hub/migrations' || path.startsWith('hub/migrations/'))
}

const defaultHubMigrateBin = resolve(new URL('../../bin/hub', import.meta.url).pathname)
let hubMigrateBin = defaultHubMigrateBin
let orchMigrate = migrateDatabase

/** Fixture-only: stub post-land migrate so a test can fail hub without a real binary. */
export function setPostLandMigrateForFixture(options: {
  orch?: typeof migrateDatabase
  hubBin?: string
} | null): void {
  orchMigrate = options?.orch ?? migrateDatabase
  hubMigrateBin = options?.hubBin ?? defaultHubMigrateBin
}

export function landingsWithPostStepError(database = db()): {
  project: string; branch: string; error: string
}[] {
  return database.query(
    `SELECT project, branch, error FROM landing
      WHERE status='landed' AND error IS NOT NULL ORDER BY id`,
  ).all() as { project: string; branch: string; error: string }[]
}

function migrateLandedJournals(project: Project, trunkBefore: string, tip: string): void {
  const paths = git(project.path, ['diff', '--name-only', `${trunkBefore}..${tip}`])
    .split('\n').filter(Boolean)
  if (!diffCarriesMigrationJournal(paths)) return
  try {
    const migrated = orchMigrate()
    if (migrated.versions.length === 0) console.log(`schema already current: ${migrated.path}`)
    else {
      console.log(`migrated ${migrated.path}`)
      for (const version of migrated.versions) console.log(`  applied ${version}`)
    }
  } catch (error) {
    throw new Error(
      `landing reached trunk at ${tip}, but orch migrate failed: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const hub = Bun.spawnSync([hubMigrateBin, 'migrate'], {
    cwd: project.path, env: process.env, stdout: 'pipe', stderr: 'pipe',
  })
  const hubOut = hub.stdout.toString().trim()
  const hubErr = hub.stderr.toString().trim()
  if (hub.exitCode !== 0) {
    throw new Error(
      `landing reached trunk at ${tip}, but hub migrate failed: ${hubErr || hubOut || `exit ${hub.exitCode}`}`,
    )
  }
  if (hubOut) console.log(hubOut)
}

function installLandedPackages(project: Project, trunkBefore: string, tip: string): void {
  const packagePaths = git(project.path, ['diff', '--name-only', `${trunkBefore}..${tip}`])
    .split('\n').filter((path) => path === 'package.json' || path.endsWith('/package.json'))
  for (const relativePackage of packagePaths) {
    const directory = join(project.path, dirname(relativePackage))
    console.log(`installing landed dependencies in ${directory}: bun install --silent`)
    const installed = Bun.spawnSync(['bun', 'install', '--silent'], {
      cwd: directory, env: process.env, stdout: 'pipe', stderr: 'pipe',
    })
    if (installed.exitCode !== 0) {
      const detail = installed.stderr.toString().trim() || installed.stdout.toString().trim() || `exit ${installed.exitCode}`
      throw new Error(`landing reached trunk at ${tip}, but bun install --silent failed in ${directory}: ${detail}`)
    }
    console.log(`installed landed dependencies in ${directory}`)
  }
}

export function land(
  cwd: string,
  branch: string,
  options: { timeoutMs?: number; message?: string; unreviewed?: string; runId?: number; queue?: boolean } = {},
): string {
  writableDb()
  const project = registeredProject(cwd).project
  const landing = db().query(
    `INSERT INTO landing (project,project_id,branch,status,session_id,started_at)
     VALUES (?,?,?,'started',?,?) RETURNING id`,
  ).get(project.name, project.id, branch, sessionId(), nowIso()) as { id: number }
  let landed = false
  try {
    const result = performLand(cwd, branch, { ...options, landingId: landing.id })
    landed = true
    writeTransaction(() => {
      db().query(
        `UPDATE landing SET tip=?,trunk_before=?,status='landed',finished_at=? WHERE id=?`,
      ).run(result.tip, result.trunkBefore, nowIso(), landing.id)
    })
    recordReviewInvalidations(
      result.project, result.repoRoot, result.tip, branch, landing.id,
    )
    try {
      installLandedPackages(result.project, result.trunkBefore, result.tip)
    } catch (error) {
      db().query(`UPDATE landing SET status='install_failed',error=?,finished_at=? WHERE id=?`)
        .run(error instanceof Error ? error.message : String(error), nowIso(), landing.id)
      throw error
    }
    try {
      migrateLandedJournals(result.project, result.trunkBefore, result.tip)
    } catch (error) {
      db().query(`UPDATE landing SET error=?,finished_at=? WHERE id=?`)
        .run(error instanceof Error ? error.message : String(error), nowIso(), landing.id)
      throw error
    }
    return result.tip
  } catch (error) {
    if (!landed) {
      const message = error instanceof Error ? error.message : String(error)
      writeTransaction(() => {
        db().query(`UPDATE landing SET status='refused',error=?,finished_at=? WHERE id=?`)
          .run(message, nowIso(), landing.id)
      })
      tryWriteContention({
        resourceKind: 'trunk', resourceKey: project.name, eventKind: 'refusal',
        cause: message, landingId: landing.id,
      })
    }
    throw error
  }
}

export function landingReviewCoverage(cwd: string): string {
  const { project, repoRoot } = registeredProject(cwd)
  const branch = git(cwd, ['branch', '--show-current']) || '(detached)'
  const tip = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const trunk = typeof project.settings.trunk === 'string' ? project.settings.trunk.trim() : ''
  return `review coverage for ${branch}:\n${coverageText(project.name, repoRoot, tip, trunk)}`
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
  const postStep = landingsWithPostStepError().filter((row) => row.project === project.name)
    .map((row) => `landed with post-step error\n  ${row.branch}: ${row.error}`)
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const invalidated = reviewInvalidationsSince(db(), project.name, today.toISOString())
  const invalidationText = invalidated.length
    ? invalidated.map((row) =>
        `  ${row.resourceKey} by landing ${row.landingId}${row.cause ? ` (${row.cause})` : ''}`).join('\n')
    : '  none'
  return `${project.name} landing lock: ${holder}\nwaiters:\n${waiters}` +
    (postStep.length ? `\n${postStep.join('\n')}` : '') +
    `\ninvalidated today:\n${invalidationText}`
}
