import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { spawn } from 'node:child_process'
import { db, liveRunCount, nowIso, sessionId, tryWriteContention, writableDb, writeTransaction, ROOT } from './db.ts'
import { reviewInvalidationsSince } from './contention.ts'
import { changeIdentity, type ChangeIdentityGitResult, type ChangeIdentityGitRunner } from './change-identity.ts'
import { projectAt, projectByName, type Project } from './projects.ts'
import { classifyReviewTier, diffNumstat } from './review-tier.ts'
import {
  contentTree, prepareSharedRefGuard, projectLockState, repoRootOf, withProjectLock,
  withWorktreeLease, targetGitEnvironment, scrubbedGitEnv, type SharedRefGuardEnvironment,
} from './worktree.ts'

const LANDING_LOCK = 'landing'
const QUEUE_LOCK = 'queue'
const LANDING_LOCK_TIMEOUT_MS = 5 * 60_000
const GATE_FAILURE_TAIL_LINES = 40
const INVARIANT_FAILED_LANDING = 'A failed landing leaves the branch worktree as it found it.'
const INVARIANT_LOCK_SCOPE =
  'Landing holds its lock only for the trunk re-check, guard verification and fast-forward, never for a gate.'
const INVARIANT_GUARD_HEAD =
  'The guard on disk is verified against HEAD, not the index, before any fast-forward.'
const INVARIANT_TRUNK_CHECKOUT =
  'The registered main checkout must have its symbolic HEAD on the configured trunk.'
const INVARIANT_JOURNAL_ALLOCATION =
  "Landing rewrites a branch's added journal entries to the next free values and refuses a hand-written idx that collides with trunk's or disagrees, naming both."
const JOURNAL_FOLDERS = ['orchestrator/migrations', 'hub/migrations'] as const
export type SharedGuardResidue = {
  repoRoot: string
  hookPath: string
  relativePath: string
  repairCommand: string
}

function namedError(detail: string, invariant: string, command: string): Error {
  return new Error(`${detail}\ninvariant: ${invariant}\ncleared by: ${command}`)
}

function assertNotProductionBranch(project: Project, trunk: string, branch: string): void {
  const production = typeof project.settings.productionBranch === 'string'
    ? project.settings.productionBranch.trim() : ''
  if (!production) return
  if (production !== trunk && branch !== production) return
  throw namedError(
    `landing ${branch} would touch configured production branch ${production}`,
    'Landing fast-forwards only the registered landing branch; production deployment is a separate lifecycle.',
    `orch project set ${project.name} --settings '{"trunk":"<landing-branch>","productionBranch":"${production}"}'`,
  )
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

const CHECKPOINT_SUBJECT = /^[A-Z]+-\d+ checkpoint run \d+ #\d+$/

type LandingState = { tip: string; branch: string; indexPath: string; indexBackup: string | null }

function captureLandingState(
  worktree: string, guard?: SharedRefGuardEnvironment,
): LandingState {
  const tip = git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'], guard)
  const branch = git(worktree, ['symbolic-ref', '--short', 'HEAD'], guard)
  const gitDir = git(worktree, ['rev-parse', '--path-format=absolute', '--git-dir'], guard)
  const indexPath = join(gitDir, 'index')
  const indexBackup = existsSync(indexPath)
    ? `${indexPath}.orch-pre-squash-${process.pid}-${randomUUID()}`
    : null
  if (indexBackup) copyFileSync(indexPath, indexBackup)
  return { tip, branch, indexPath, indexBackup }
}

function discardLandingState(state: LandingState): void {
  if (state.indexBackup) rmSync(state.indexBackup, { force: true })
}

function restoreLandingState(
  worktree: string, state: LandingState, cause: unknown,
  guard?: SharedRefGuardEnvironment,
): Error {
  const detail = cause instanceof Error ? cause.message : String(cause)
  try {
    gitOk(worktree, ['cherry-pick', '--abort'], guard)
    gitOk(worktree, ['rebase', '--abort'], guard)
    const head = git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'], guard)
    if (head !== state.tip) git(worktree, ['reset', '--keep', state.tip], guard)
    git(worktree, ['checkout', state.tip, '--', '.'], guard)
    git(worktree, ['update-ref', `refs/heads/${state.branch}`, state.tip], guard)
    git(worktree, ['checkout', state.branch], guard)
    if (state.indexBackup && existsSync(state.indexBackup)) {
      copyFileSync(state.indexBackup, state.indexPath)
    }
  } catch (restoreError) {
    return Object.assign(namedError(
      `${detail}\nrestore after failed landing also failed: ${String(restoreError)}`,
      INVARIANT_FAILED_LANDING,
      `git -C ${shellQuote(worktree)} reset --hard ${state.tip}`,
    ), { reviewRework: reviewRework(cause) })
  } finally {
    discardLandingState(state)
  }
  return Object.assign(namedError(
    `${detail}\nrestored branch tip ${state.tip} and index to the pre-squash state`,
    INVARIANT_FAILED_LANDING,
    `git -C ${shellQuote(worktree)} reset --hard ${state.tip}`,
  ), { reviewRework: reviewRework(cause) })
}

/** Fold checkpoint deltas into the next authored commit, retaining a trailing checkpoint. */
export function squashCheckpointCommits(
  worktree: string, trunkOid: string, guard?: SharedRefGuardEnvironment,
): boolean {
  const commits = git(worktree, ['rev-list', '--reverse', `${trunkOid}..HEAD`], guard)
    .split('\n').filter(Boolean)
  const subjects = commits.map((commit) =>
    git(worktree, ['show', '-s', '--format=%s', commit], guard))
  if (!subjects.some((subject) => CHECKPOINT_SUBJECT.test(subject))) return false
  const original = captureLandingState(worktree, guard)
  try {
    git(worktree, ['reset', '--hard', trunkOid], guard)
    let pendingCheckpoint: string | null = null
    for (let i = 0; i < commits.length; i++) {
      const commit = commits[i]!
      const checkpoint = CHECKPOINT_SUBJECT.test(subjects[i]!)
      git(worktree, ['cherry-pick', '--no-commit', commit], guard)
      if (checkpoint) {
        pendingCheckpoint = commit
        continue
      }
      git(worktree, ['commit', '-C', commit], guard)
      pendingCheckpoint = null
    }
    if (pendingCheckpoint) git(worktree, ['commit', '-C', pendingCheckpoint], guard)
    discardLandingState(original)
    return true
  } catch (error) {
    throw restoreLandingState(worktree, original, error, guard)
  }
}

function rebaseInProgress(worktree: string, guard?: SharedRefGuardEnvironment): boolean {
  const gitDir = git(worktree, ['rev-parse', '--path-format=absolute', '--git-dir'], guard)
  return existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))
}

function assertLandingWorktreeReady(
  worktree: string, branch: string, guard?: SharedRefGuardEnvironment,
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

function continueRebaseWithJournalConflictResolution(
  worktree: string, trunkOid: string, guard: SharedRefGuardEnvironment,
): boolean {
  const start = Bun.spawnSync(['git', 'rebase', trunkOid], {
    cwd: worktree, env: { ...targetGitEnvironment(worktree), ...guard }, stdout: 'pipe', stderr: 'pipe',
  })
  if (start.exitCode === 0) return false
  let resolvedJournal = false
  let failure = start.stderr.toString().trim()
  while (rebaseInProgress(worktree, guard)) {
    const conflicts = git(worktree, ['diff', '--name-only', '--diff-filter=U'], guard).split('\n').filter(Boolean)
    if (!conflicts.length || conflicts.some((path) =>
      path !== 'orchestrator/migrations/meta/_journal.json' &&
      path !== 'hub/migrations/meta/_journal.json')) {
      throw new Error(failure || 'rebase conflict')
    }
    for (const path of conflicts) {
      resolvedJournal = true
      const trunk = parseMigrationJournal(git(worktree, ['show', `:2:${path}`], guard))
      const incoming = parseMigrationJournal(git(worktree, ['show', `:3:${path}`], guard))
      const trunkTags = new Set(trunk.entries.map((entry) => entry.tag))
      const entries = [...trunk.entries, ...incoming.entries.filter((entry) => !trunkTags.has(entry.tag))]
      writeFileSync(join(worktree, path), `${JSON.stringify({
        version: trunk.version ?? incoming.version ?? '7',
        dialect: trunk.dialect ?? incoming.dialect ?? 'sqlite',
        entries,
      }, null, 2)}\n`)
      git(worktree, ['add', '--', path], guard)
    }
    const continued = Bun.spawnSync(['git', 'rebase', '--continue'], {
      cwd: worktree,
      env: { ...targetGitEnvironment(worktree), ...guard, GIT_EDITOR: 'true' },
      stdout: 'pipe', stderr: 'pipe',
    })
    if (continued.exitCode === 0) return resolvedJournal
    failure = continued.stderr.toString().trim()
  }
  throw new Error(failure || 'rebase failed')
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
    const resolvedJournalConflict = continueRebaseWithJournalConflictResolution(worktree, trunkOid, guard)
    const taskKey = branch.match(/[A-Z]+-\d+/)?.[0]
    const allocated = allocateLandingJournals(
      worktree, trunkOid, guard, taskKey ? [taskKey] : [], resolvedJournalConflict,
    )
    if (allocated.length) {
      console.log(`allocated journal ${allocated.map((row) => `${row.from} -> ${row.to}`).join(', ')}`)
    }
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
  patchId?: string | null
  pathSet?: string | null
  commitMessage?: string | null
  outdatedReason?: string | null
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
    `SELECT r.id, r.patch_id, r.path_set, r.commit_message, r.outdated_reason,
            rl.lens, rl.run_id, rl.reviewed_tree, run.input_tree,
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
    id: number; patch_id: string | null; path_set: string | null; commit_message: string | null
    outdated_reason: string | null; lens: string; run_id: number; reviewed_tree: string | null
    input_tree: string | null; branch: string | null; base_commit: string | null
    launch_cwd: string | null; head_commit: string | null
  }[]
  const grouped = new Map<number, ReviewCoverageInput>()
  for (const row of rows) {
    const review = grouped.get(row.id) ?? { id: row.id, patchId: row.patch_id, pathSet: row.path_set,
      commitMessage: row.commit_message, outdatedReason: row.outdated_reason, lenses: [] }
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
  | ({ kind: 'carried'; class: 'trivial-rebase' | 'no-code-change'; resolution: 'pin' | 'walk' } & Omit<ReviewCarry, 'project' | 'branch'>)
  | { kind: 'invalid'; reason: string; resolution?: 'pin' | 'walk' }

export type CoverageGitResult = ChangeIdentityGitResult
export type CoverageGitRunner = ChangeIdentityGitRunner

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
  if (overlap.length) return { kind: 'invalid', reason: `overlapping paths: ${overlap.sort().join(', ')}`, resolution: resolved.resolution }
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
  const messageResult = runner(['log', '--format=%B', `${newBase}..${tip}`])
  const message = messageResult.ok ? messageResult.out : ''
  return {
    kind: 'carried', class: review.commitMessage !== null && review.commitMessage !== undefined &&
      review.commitMessage !== message ? 'no-code-change' : 'trivial-rebase',
    resolution: resolved.resolution, tip, tree, reviewId: review.id, reviewedCommit, reviewedTree,
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
          return `review ${review.id}: carried (patch-id ${verdict.patchId}; class ${verdict.class}; ` +
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
): { tree: string; carry: ReviewCarry | null; validReviewIds: number[] } {
  landingOrder('coverage')
  const candidateTree = git(repoRoot, ['rev-parse', `${tip}^{tree}`])
  const reviews = completedReviews(project.name)
  const exact = reviews.filter((review) => review.lenses.length > 0 &&
    review.lenses.every((lens) => lens.tree === candidateTree))
  if (exact.length) {
    return { tree: candidateTree, carry: null, validReviewIds: exact.map((review) => review.id) }
  }
  const verdicts = reviews.map((review) => ({ review, verdict: reviewCoverageVerdict(repoRoot, review, tip, trunk) }))
  const carried = verdicts.find((item) => item.verdict.kind === 'carried')
  if (carried?.verdict.kind === 'carried') {
    return {
      tree: candidateTree,
      carry: { project: project.name, branch, ...carried.verdict },
      validReviewIds: [carried.review.id],
    }
  }
  const reworked = verdicts.flatMap(({ review, verdict }) =>
    verdict.kind === 'invalid' && ['patch-id differs', 'path set differs'].includes(verdict.reason)
      && reviewBelongsToCandidate(review, branch)
      ? [{ id: review.id, reason: verdict.reason }] : [])
  const reruns = verdicts.flatMap(({ review, verdict }) => verdict.kind === 'invalid'
    ? review.lenses.map((lens) => {
      let introduced = ''
      if (verdict.reason.startsWith('overlapping paths')) {
        try {
          const landings = db().query(
            `SELECT DISTINCT landing_id FROM contention
             WHERE resource_kind='review' AND resource_key=? AND event_kind='invalidation'
               AND cause=? AND landing_id IS NOT NULL ORDER BY landing_id`,
          ).all(branch, `review ${review.id}`) as { landing_id: number }[]
          if (landings.length) introduced = `; introduced by landing${landings.length === 1 ? '' : 's'} ${landings.map((row) => row.landing_id).join(', ')}`
        } catch { /* an older store has no contention ledger */ }
      }
      return `review ${review.id} (${verdict.reason}${introduced}); re-run lens ${lens.lens}: ` +
        `orch do review-lens --review ${branch} --lens ${lens.lens}`
    })
    : [])
  throw Object.assign(namedError(
    `refusing to land unreviewed content\ncandidate tree: ${candidateTree}\n` +
    `${coverageText(project.name, repoRoot, tip, trunk)}\n` +
    `${reruns.join('\n')}`,
    INVARIANT_LOCK_SCOPE,
    reruns[0]?.replace(/^.*: /, '') ?? `orch do review-lens --review ${branch} --lens <id>`,
  ), { reviewRework: reworked })
}

function authorizeLanding(
  project: Project, repoRoot: string, worktree: string, branch: string, tip: string, trunk: string,
  runId?: number, unreviewed?: string,
  ownership?: { worktree: string; tip: string },
): {
  override: { project: string; branch: string; tip: string; tree: string; reason: string } | null
  carry: ReviewCarry | null
  validReviewIds: number[]
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
    const landingReal = realOrNull(ownership?.worktree ?? worktree)
    const owners = recorded.filter((candidate) => {
      if (!candidate.worktree || landingReal === null) return false
      if (realOrNull(candidate.worktree) !== landingReal) return false
      try {
        return git(candidate.worktree, ['rev-parse', '--verify', 'HEAD^{commit}']) === (ownership?.tip ?? tip)
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
    return { override: { project: project.name, branch, tip, tree, reason }, carry: null,
      validReviewIds: [] as number[] }
  }
  const coverage = requireReviewCoverage(project, repoRoot, branch, tip, trunk)
  return { override: null, carry: coverage.carry, validReviewIds: coverage.validReviewIds }
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
    queue?: boolean; landingId?: number; strandLive?: string; keepCheckpoints?: boolean
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
  assertNotProductionBranch(project, trunk, branch)
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
  const worktree = ensureLandingWorktree(repoRoot, branch, options.runId)
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
    const recordedTrunk = trunkCommit(repoRoot, trunk, guard)
    const original = captureLandingState(worktree, guard)
    try {
      if (!options.keepCheckpoints) squashCheckpointCommits(worktree, recordedTrunk, guard)
    // A message-only amend changes the commit hash. The gate must run on the
    // commit that becomes trunk, so the message is rewritten before rebase.
    if (options.message !== undefined) amendLandingMessage(worktree, options.message, guard)
    if (options.unreviewed === undefined) {
      const authorization = authorizeLanding(
        project, repoRoot, worktree, branch,
        git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'], guard), recordedTrunk,
        options.runId, options.unreviewed,
      )
      for (const reviewId of authorization.validReviewIds) {
        db().query('UPDATE review SET outdated_at=NULL, outdated_reason=NULL WHERE id=?').run(reviewId)
      }
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
          const authorization = authorizeLandingTip(
            project, repoRoot, worktree, branch, tip, gatedTrunk,
            options.runId, options.unreviewed,
          )
          refuseOrWaitLiveRuns(
            project, repoRoot, worktree, gatedTrunk, tip, options.strandLive, options.timeoutMs ?? timeoutMs,
            options.landingId ?? null,
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
      if (losses >= 3) {
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
    } catch (error) {
      throw restoreLandingState(worktree, original, error, guard)
    } finally {
      discardLandingState(original)
    }
  }, timeoutMs)
}

class MergeGroupTrunkMoved extends Error {
  constructor(readonly from: string, readonly to: string) {
    super(`trunk moved during merge-group gate from ${from} to ${to}`)
  }
}

class MergeGroupMemberFailure extends Error {
  constructor(
    readonly branch: string,
    detail: string,
    readonly reviewRework: { id: number; reason: string }[] = [],
  ) { super(detail) }
}

export function diffCarriesMigrationJournal(paths: string[]): boolean {
  return paths.some((path) =>
    path === 'orchestrator/migrations' || path.startsWith('orchestrator/migrations/') ||
    path === 'hub/migrations' || path.startsWith('hub/migrations/'))
}

type MigrationJournalEntry = {
  idx: number; version: string; when: number; tag: string; breakpoints?: boolean
}
type MigrationJournal = {
  version?: string; dialect?: string; entries: MigrationJournalEntry[]
}

function parseMigrationJournal(raw: string, allowDuplicateWhen = false): MigrationJournal {
  const parsed = JSON.parse(raw) as { version?: string; dialect?: string; entries?: unknown }
  if (!Array.isArray(parsed.entries)) return { version: parsed.version, dialect: parsed.dialect, entries: [] }
  const journal = {
    version: parsed.version, dialect: parsed.dialect,
    entries: parsed.entries.filter((entry): entry is MigrationJournalEntry => {
      if (!entry || typeof entry !== 'object') return false
      const row = entry as MigrationJournalEntry
      return Number.isInteger(row.idx) && typeof row.tag === 'string' && Number.isFinite(row.when)
    }),
  }
  const whens = new Set<number>()
  let previous = -Infinity
  for (const entry of journal.entries) {
    if (!allowDuplicateWhen && whens.has(entry.when)) {
      throw namedError(
        `refusing journal with duplicate when ${entry.when}`,
        INVARIANT_JOURNAL_ALLOCATION,
        'edit migrations/meta/_journal.json so every when is unique',
      )
    }
    if (!allowDuplicateWhen && entry.when <= previous) {
      throw namedError(
        `refusing journal with unordered when ${entry.when} after ${previous}`,
        INVARIANT_JOURNAL_ALLOCATION,
        'edit migrations/meta/_journal.json so when values are strictly increasing',
      )
    }
    whens.add(entry.when)
    previous = entry.when
  }
  return journal
}

function journalAtCommit(
  worktree: string, oid: string, folder: string, guard?: SharedRefGuardEnvironment,
): MigrationJournal {
  let raw: string
  try {
    raw = git(worktree, ['show', `${oid}:${folder}/meta/_journal.json`], guard)
  } catch {
    return { version: '7', dialect: 'sqlite', entries: [] }
  }
  return parseMigrationJournal(raw)
}

function journalOnDisk(worktree: string, folder: string, allowDuplicateWhen = false): MigrationJournal {
  const path = join(worktree, folder, 'meta', '_journal.json')
  if (!existsSync(path)) return { version: '7', dialect: 'sqlite', entries: [] }
  return parseMigrationJournal(readFileSync(path, 'utf8'), allowDuplicateWhen)
}

function journalTagParts(tag: string): { prefix: number; suffix: string } | null {
  const match = tag.match(/^(\d+)_(.+)$/)
  if (!match) return null
  return { prefix: Number(match[1]), suffix: match[2]! }
}

function paddedJournalTag(idx: number, suffix: string): string {
  return `${String(idx).padStart(4, '0')}_${suffix}`
}

function allocateOneJournal(
  worktree: string, fromOid: string, folder: string, guard?: SharedRefGuardEnvironment,
  allowDuplicateWhen = false,
): { from: string; to: string }[] {
  const trunk = journalAtCommit(worktree, fromOid, folder, guard)
  const working = journalOnDisk(worktree, folder, allowDuplicateWhen)
  const trunkByTag = new Map(trunk.entries.map((entry) => [entry.tag, entry]))
  const added = working.entries.filter((entry) => !trunkByTag.has(entry.tag))
  for (const entry of working.entries) {
    const onTrunk = trunkByTag.get(entry.tag)
    if (onTrunk && onTrunk.idx !== entry.idx) {
      throw namedError(
        `refusing to land: hand-written idx ${entry.idx} collides with trunk's ${onTrunk.idx} for ${entry.tag}`,
        INVARIANT_JOURNAL_ALLOCATION,
        `edit ${folder}/meta/_journal.json`,
      )
    }
  }
  if (!added.length) return []
  for (const entry of added) {
    const parts = journalTagParts(entry.tag)
    if (!parts) {
      throw namedError(
        `refusing to land: journal tag ${entry.tag} has no numeric prefix`,
        INVARIANT_JOURNAL_ALLOCATION,
        `edit ${folder}/meta/_journal.json`,
      )
    }
    if (parts.prefix !== entry.idx) {
      throw namedError(
        `refusing to land: hand-written idx ${entry.idx} disagrees with filename prefix ${parts.prefix} (${entry.tag})`,
        INVARIANT_JOURNAL_ALLOCATION,
        `edit ${folder}/meta/_journal.json`,
      )
    }
  }
  const maxTrunkIdx = trunk.entries.reduce((max, entry) => Math.max(max, entry.idx), -1)
  let nextIdx = maxTrunkIdx + 1
  let nextWhen = trunk.entries.reduce((max, entry) => Math.max(max, entry.when), 0) + 1
  const addedOrdered = [...added].sort((a, b) => a.idx - b.idx || a.tag.localeCompare(b.tag))
  const remap = new Map<string, { idx: number; when: number; tag: string }>()
  for (const entry of addedOrdered) {
    const parts = journalTagParts(entry.tag)!
    const tag = paddedJournalTag(nextIdx, parts.suffix)
    const when = Math.max(nextWhen, entry.when)
    remap.set(entry.tag, { idx: nextIdx, when, tag })
    nextIdx += 1
    nextWhen = when + 1
  }
  const rewritten: { from: string; to: string }[] = []
  let changed = false
  for (const entry of addedOrdered) {
    const mapped = remap.get(entry.tag)!
    if (entry.idx !== mapped.idx || entry.when !== mapped.when || entry.tag !== mapped.tag) changed = true
    if (entry.tag !== mapped.tag) {
      const fromPath = join(worktree, folder, `${entry.tag}.sql`)
      const toPath = join(worktree, folder, `${mapped.tag}.sql`)
      if (!existsSync(fromPath)) {
        throw namedError(
          `refusing to land: journal tag ${entry.tag} has no ${folder}/${entry.tag}.sql`,
          INVARIANT_JOURNAL_ALLOCATION,
          `add ${folder}/${entry.tag}.sql`,
        )
      }
      if (existsSync(toPath)) {
        throw namedError(
          `refusing to land: cannot rename ${entry.tag} to ${mapped.tag}; ${mapped.tag}.sql already exists`,
          INVARIANT_JOURNAL_ALLOCATION,
          `inspect ${folder}/${mapped.tag}.sql`,
        )
      }
      renameSync(fromPath, toPath)
    }
    rewritten.push({ from: entry.tag, to: mapped.tag })
  }
  if (!changed) return []
  const entries = working.entries.map((entry) => {
    const mapped = remap.get(entry.tag)
    return mapped ? { ...entry, idx: mapped.idx, when: mapped.when, tag: mapped.tag } : entry
  }).sort((a, b) => a.idx - b.idx)
  writeFileSync(
    join(worktree, folder, 'meta', '_journal.json'),
    `${JSON.stringify({
      version: working.version ?? '7',
      dialect: working.dialect ?? 'sqlite',
      entries,
    }, null, 2)}\n`,
  )
  return rewritten
}

/**
 * The landing-authored allocation commit carries the landing's own task key
 * (or 'orch' when the branch names none) and is recognised by shape, never by
 * a fixed key: a landing in another project must not cite DEV-370.
 */
const ALLOCATION_SUBJECT = /^(?:[A-Z]+-\d+|orch) allocate journal at landing$/
function allocationSubject(taskKey: string | undefined): string {
  return `${taskKey ?? 'orch'} allocate journal at landing`
}

/** Rewrite added journal entries to the next free idx/when/tag before the gate. */
export function allocateLandingJournals(
  worktree: string, fromOid: string, guard?: SharedRefGuardEnvironment, taskKeys: string[] = [],
  allowDuplicateWhen = false,
): { from: string; to: string }[] {
  const rewritten: { from: string; to: string }[] = []
  for (const folder of JOURNAL_FOLDERS) {
    rewritten.push(...allocateOneJournal(worktree, fromOid, folder, guard, allowDuplicateWhen))
  }
  if (!rewritten.length) return rewritten
  const existing = JOURNAL_FOLDERS.filter((folder) => existsSync(join(worktree, folder)))
  if (existing.length) git(worktree, ['add', '-A', '--', ...existing], guard)
  const dirty = git(worktree, ['status', '--porcelain=v1', '--untracked-files=all'], guard)
  if (!dirty) return rewritten
  const body = [...new Set(taskKeys)].map((key) => `Member task: ${key}`).join('\n')
  git(worktree, [
    'commit', '-m', allocationSubject(taskKeys[0]),
    ...(body ? ['-m', body] : []),
  ], guard)
  return rewritten
}

function allocationParentIfMechanical(
  repoRoot: string, tip: string, branch: string,
): string | null {
  const subject = git(repoRoot, ['show', '-s', '--format=%s', tip])
  if (!ALLOCATION_SUBJECT.test(subject)) return null
  const parent = git(repoRoot, ['rev-parse', `${tip}^`])
  const changed = git(repoRoot, ['diff', '--name-status', '-M', `${parent}..${tip}`]).split('\n').filter(Boolean)
  const allowedRoot = (path: string) =>
    path.startsWith('orchestrator/migrations/') || path.startsWith('hub/migrations/')
  const allowed = changed.length > 0 && changed.every((line) => {
    const [status, ...paths] = line.split('\t')
    if (!status || !paths.length || !paths.every(allowedRoot)) return false
    if (status === 'M') return paths.every((path) => path.endsWith('/meta/_journal.json'))
    return status.startsWith('R') || status === 'A'
  })
  if (!allowed) {
    throw namedError(
      `refusing ${branch}: landing-authored journal allocation touched a non-journal path`,
      'Every landed commit is covered by a review, the four-fact carry, an explicit override, or the mechanical journal-allocation rule.',
      `orch land ${branch}`,
    )
  }
  return parent
}

function authorizeLandingTip(
  project: Project, repoRoot: string, worktree: string, branch: string, tip: string, trunk: string,
  runId?: number, unreviewed?: string,
): ReturnType<typeof authorizeLanding> {
  const memberTip = allocationParentIfMechanical(repoRoot, tip, branch) ?? tip
  return authorizeLanding(project, repoRoot, worktree, branch, memberTip, trunk, runId, unreviewed)
}

let fixtureMigrateBins: { orchBin?: string; hubBin?: string } | null = null

/** Fixture-only: stub post-land migrate so a test can fail hub without a real binary. */
export function setPostLandMigrateForFixture(options: {
  orchBin?: string
  hubBin?: string
} | null): void {
  fixtureMigrateBins = options
}

export function landingsWithPostStepError(database = db()): {
  project: string; branch: string; error: string
}[] {
  return database.query(
    `SELECT project, branch, error FROM landing
      WHERE status='install_failed' AND error IS NOT NULL ORDER BY id`,
  ).all() as { project: string; branch: string; error: string }[]
}

function migrateLandedJournals(project: Project, trunkBefore: string, tip: string): string {
  const paths = git(project.path, ['diff', '--name-only', `${trunkBefore}..${tip}`])
    .split('\n').filter(Boolean)
  if (!diffCarriesMigrationJournal(paths)) return ''
  const env = { ...process.env }
  delete env.ORCH_DB
  delete env.ORCH_DEPTH
  const bins = {
    orchBin: fixtureMigrateBins?.orchBin ?? join(project.path, 'bin', 'orch'),
    hubBin: fixtureMigrateBins?.hubBin ?? join(project.path, 'bin', 'hub'),
  }
  const captured: string[] = []
  for (const [name, bin] of [['orch', bins.orchBin], ['hub', bins.hubBin]] as const) {
    const migrated = Bun.spawnSync([bin, 'migrate'], {
      cwd: project.path, env, stdout: 'pipe', stderr: 'pipe',
    })
    const out = migrated.stdout.toString().trim()
    const err = migrated.stderr.toString().trim()
    if (migrated.exitCode !== 0) {
      throw new Error(
        `landing reached trunk at ${tip}, but ${name} migrate failed: ${err || out || `exit ${migrated.exitCode}`}` +
        `; clear from the main checkout with: ${name} migrate`,
      )
    }
    captured.push(`${name}: ${out || '(no output)'}`)
    if (out) console.log(out)
  }
  return captured.join('\n')
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

type LandingRow = {
  id: number; project: string; branch: string; status: string
  path_set: string | null; steps: string | null; session_id: string | null
  requested_at: string | null; causing_landing_id: number | null
  tip: string | null; error: string | null
  claim_pid: number | null; claim_session: string | null
}

type LandingStep = {
  name: string; duration_ms?: number
  unreviewed?: string; strandLive?: string; message?: string; keepCheckpoints?: boolean
  output?: string
}

function parseSteps(raw: string | null): LandingStep[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed as LandingStep[] : []
  } catch { return [] }
}

function appendStep(id: number, name: string, durationMs: number, output?: string): void {
  const row = db().query('SELECT steps FROM landing WHERE id=?').get(id) as { steps: string | null } | null
  const steps = [...parseSteps(row?.steps ?? null), {
    name, duration_ms: durationMs, ...(output ? { output } : {}),
  }]
  db().query('UPDATE landing SET steps=? WHERE id=?').run(JSON.stringify(steps), id)
}

function flagsOf(row: LandingRow): { unreviewed?: string; strandLive?: string; message?: string; keepCheckpoints?: boolean } {
  const flags = parseSteps(row.steps).find((step) => step.name === '_flags')
  if (!flags) return {}
  return {
    ...(flags.unreviewed ? { unreviewed: flags.unreviewed } : {}),
    ...(flags.strandLive ? { strandLive: flags.strandLive } : {}),
    ...(flags.message ? { message: flags.message } : {}),
    ...(flags.keepCheckpoints ? { keepCheckpoints: true } : {}),
  }
}

function pathSetOf(repoRoot: string, trunk: string, branch: string): string[] {
  try {
    return git(repoRoot, ['diff', '--name-only', `${trunk}...${branch}`]).split('\n').filter(Boolean)
  } catch { return [] }
}

function pathsOverlap(a: string[], b: string[]): boolean {
  const other = new Set(b)
  return a.some((path) => other.has(path))
}

function queuedLandings(project: string): LandingRow[] {
  return db().query(
    `SELECT id, project, branch, status, path_set, steps, session_id, requested_at,
            causing_landing_id, tip, error, claim_pid, claim_session
       FROM landing WHERE project=? AND status='queued' ORDER BY id`,
  ).all(project) as LandingRow[]
}

function refuseChangedEnqueuedTips(project: string, repoRoot: string): void {
  for (const row of queuedLandings(project)) {
    if (row.tip === null) continue
    const current = gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${row.branch}`])
      ? git(repoRoot, ['rev-parse', `refs/heads/${row.branch}^{commit}`]) : null
    if (current === row.tip) continue
    const message = `refusing ${row.branch}: current tip ${current ?? 'missing'} differs from enqueued tip ${row.tip ?? 'missing'}` +
      `\ninvariant: the enqueued tip is what was authorized` +
      `\ncleared by: orch land ${row.branch}`
    db().query(
      `UPDATE landing SET status='refused',error=?,finished_at=?,claim_pid=NULL,claim_session=NULL WHERE id=?`,
    ).run(message, nowIso(), row.id)
  }
}

function claimPidIsDead(pid: unknown): pid is number {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false
  try {
    process.kill(Number(pid), 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}

function reclaimDeadLandingClaims(project: string): void {
  const running = db().query(
    `SELECT id, branch, claim_pid, claim_session FROM landing
      WHERE project=? AND status='running'`,
  ).all(project) as { id: number; branch: string; claim_pid: number | null; claim_session: string | null }[]
  for (const row of running) {
    if (!claimPidIsDead(row.claim_pid)) continue
    const message = `landing ${row.id} ${row.branch} was claimed by dead pid ${row.claim_pid}` +
      ` (session ${row.claim_session ?? 'unknown'}); the branch may hold a half-done rebase` +
      `\ninvariant: a running landing has a live owner` +
      `\ncleared by: orch land ${row.branch}`
    db().query(
      `UPDATE landing SET status='refused',error=?,finished_at=?,claim_pid=NULL,claim_session=NULL
        WHERE id=? AND status='running' AND claim_pid=?`,
    ).run(message, nowIso(), row.id, row.claim_pid)
  }
}

function claimLandingRows(rows: LandingRow[]): void {
  for (const row of rows) {
    db().query(
      `UPDATE landing SET status='running',claim_pid=?,claim_session=? WHERE id=?`,
    ).run(process.pid, sessionId(), row.id)
    row.claim_pid = process.pid
    row.claim_session = sessionId()
  }
}

function ensureLandingWorktree(repoRoot: string, branch: string, runId?: number): string {
  const existing = worktreesForBranch(repoRoot, branch)[0]
  if (existing && existsSync(existing)) return existing
  const recordedBlock = recordedLandingBlock(
    registeredProject(repoRoot).project.name, branch, runId,
  )
  if (recordedBlock && !existsSync(recordedBlock.worktree)) {
    throw namedError(
      `refusing to land ${branch}: ${recordedBlock.detail}`,
      recordedBlock.invariant,
      recordedBlock.command,
    )
  }
  const path = join(repoRoot, '.claude', 'worktrees', `orch-land-${branch.replace(/[^A-Za-z0-9._-]+/g, '-')}`)
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) gitOk(repoRoot, ['worktree', 'remove', '--force', path])
  git(repoRoot, ['worktree', 'add', path, branch])
  return path
}

function liveRunIds(): { id: number; job: string }[] {
  return db().query(
    `SELECT id, job FROM run WHERE status IN ('running','asking') ORDER BY id`,
  ).all() as { id: number; job: string }[]
}

function refuseOrWaitLiveRuns(
  project: Project, repoRoot: string, worktree: string, from: string, tip: string,
  strandLive: string | undefined, timeoutMs: number, landingId: number | null,
): void {
  const paths = git(worktree, ['diff', '--name-only', `${from}..${tip}`]).split('\n').filter(Boolean)
  if (!diffCarriesMigrationJournal(paths)) return
  const live = liveRunIds()
  if (!live.length) return
  for (const run of live) {
    tryWriteContention({
      resourceKind: 'store', resourceKey: String(run.id), eventKind: 'invalidation',
      cause: `journal landing would strand run ${run.id} (${run.job})`,
      runId: run.id, landingId,
    })
  }
  const names = live.map((run) => `${run.id} (${run.job})`).join(', ')
  console.log(`journal landing would strand live runs: ${names}`)
  if (strandLive) {
    console.log(`proceeding with --strand-live: ${strandLive}`)
    return
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && liveRunIds().length) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
  const remaining = liveRunIds()
  if (!remaining.length) return
  throw namedError(
    `refusing to land: journal diff would strand live runs ${remaining.map((run) => run.id).join(', ')}`,
    'A landing whose diff carries a journal entry does not silently strand in-flight runs.',
    `wait for those runs to terminalise, or orch land <branch> --strand-live <reason>`,
  )
}

function recordOverlapInvalidations(
  project: Project, repoRoot: string, landedPaths: string[], landedBranch: string, landingId: number,
): void {
  const queued = db().query(
    `SELECT id, branch, path_set FROM landing
      WHERE project=? AND status='queued' AND id!=? AND branch!=?`,
  ).all(project.name, landingId, landedBranch) as { id: number; branch: string; path_set: string | null }[]
  for (const row of queued) {
    const paths = row.path_set ? JSON.parse(row.path_set) as string[] : []
    if (!pathsOverlap(landedPaths, paths)) continue
    db().query(
      `UPDATE landing SET status='rebase_required', causing_landing_id=?, error=?,claim_pid=NULL,claim_session=NULL WHERE id=?`,
    ).run(landingId, `path set overlaps landing ${landingId}`, row.id)
    tryWriteContention({
      resourceKind: 'trunk', resourceKey: row.branch, eventKind: 'invalidation',
      cause: `path overlap with landing ${landingId}`, landingId,
    })
    console.log(`rebase required for ${row.branch} (overlaps landing ${landingId})`)
  }
  recordReviewInvalidations(project, repoRoot, git(repoRoot, ['rev-parse', 'HEAD']), landedBranch, landingId)
}

function finishLanded(
  landingId: number, cwd: string, branch: string,
  result: { tip: string; trunkBefore: string; project: Project; repoRoot: string },
  options: { timeoutMs?: number; message?: string; unreviewed?: string; runId?: number; strandLive?: string },
): string {
  writeTransaction(() => {
    db().query(
      `UPDATE landing SET tip=?,trunk_before=?,status='landed',finished_at=?,claim_pid=NULL,claim_session=NULL WHERE id=?`,
    ).run(result.tip, result.trunkBefore, nowIso(), landingId)
  })
  const landedPaths = git(result.repoRoot, ['diff', '--name-only', `${result.trunkBefore}..${result.tip}`])
    .split('\n').filter(Boolean)
  recordOverlapInvalidations(result.project, result.repoRoot, landedPaths, branch, landingId)
  try {
    const started = Date.now()
    installLandedPackages(result.project, result.trunkBefore, result.tip)
    appendStep(landingId, 'install', Date.now() - started)
  } catch (error) {
    db().query(`UPDATE landing SET status='install_failed',error=?,finished_at=?,claim_pid=NULL,claim_session=NULL WHERE id=?`)
      .run(error instanceof Error ? error.message : String(error), nowIso(), landingId)
    throw error
  }
  try {
    const started = Date.now()
    const output = migrateLandedJournals(result.project, result.trunkBefore, result.tip)
    appendStep(landingId, 'migrate', Date.now() - started, output)
  } catch (error) {
    db().query(`UPDATE landing SET status='install_failed',error=?,finished_at=?,claim_pid=NULL,claim_session=NULL WHERE id=?`)
      .run(error instanceof Error ? error.message : String(error), nowIso(), landingId)
    throw error
  }
  return result.tip
}

function processOneLanding(
  cwd: string, row: LandingRow,
  options: { timeoutMs?: number; message?: string; unreviewed?: string; runId?: number; strandLive?: string },
): void {
  claimLandingRows([row])
  const started = Date.now()
  const flags = flagsOf(row)
  try {
    const result = performLand(cwd, row.branch, {
      ...options, ...flags, landingId: row.id,
    })
    appendStep(row.id, 'rebase-gate-ff', Date.now() - started)
    finishLanded(row.id, cwd, row.branch, result, options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const current = db().query('SELECT status FROM landing WHERE id=?').get(row.id) as { status: string } | null
    if (current && current.status !== 'landed' && current.status !== 'install_failed') {
      writeTransaction(() => {
        db().query(`UPDATE landing SET status='refused',error=?,finished_at=?,claim_pid=NULL,claim_session=NULL WHERE id=?`)
          .run(message, nowIso(), row.id)
        markReviewsOutdated(reviewRework(error))
      })
      tryWriteContention({
        resourceKind: 'trunk', resourceKey: row.project, eventKind: 'refusal',
        cause: message, landingId: row.id,
      })
    }
    throw error
  }
}

function rebaseBranchesOntoTrunk(
  repoRoot: string, worktree: string, trunkOid: string, rows: LandingRow[],
): { row: LandingRow; from: string; to: string }[] {
  git(worktree, ['checkout', '--detach', trunkOid])
  const ranges: { row: LandingRow; from: string; to: string }[] = []
  for (const row of rows) {
    const branch = row.branch
    const current = git(repoRoot, ['rev-parse', `refs/heads/${branch}^{commit}`])
    if (row.tip !== null && current !== row.tip) {
      throw new MergeGroupMemberFailure(branch,
        `current tip ${current} differs from enqueued tip ${row.tip}`)
    }
    const from = git(worktree, ['rev-parse', 'HEAD'])
    const mergeBase = git(repoRoot, ['merge-base', trunkOid, `refs/heads/${branch}`])
    const commits = git(repoRoot, ['rev-list', '--reverse', `${mergeBase}..refs/heads/${branch}`])
      .split('\n').filter(Boolean)
    for (const commit of commits) {
      const picked = Bun.spawnSync(['git', 'cherry-pick', commit], {
        cwd: worktree, env: scrubbedGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (picked.exitCode !== 0) {
        Bun.spawnSync(['git', 'cherry-pick', '--abort'], {
          cwd: worktree, env: scrubbedGitEnv(), stdout: 'pipe', stderr: 'pipe',
        })
        throw new MergeGroupMemberFailure(branch, namedError(
          `merge-group cherry-pick of ${commit} from ${branch} failed: ${picked.stderr.toString().trim()}`,
          INVARIANT_FAILED_LANDING,
          `git -C ${shellQuote(worktree)} status`,
        ).message)
      }
    }
    const flags = flagsOf(row)
    if (!flags.keepCheckpoints) {
      squashCheckpointCommits(worktree, from, prepareSharedRefGuard(worktree))
    }
    if (flags.message !== undefined) amendLandingMessage(worktree, flags.message, prepareSharedRefGuard(worktree))
    ranges.push({ row, from, to: git(worktree, ['rev-parse', 'HEAD']) })
  }
  return ranges
}

function processMergeGroup(
  cwd: string, rows: LandingRow[],
  options: { timeoutMs?: number; unreviewed?: string; strandLive?: string },
  losses = 0,
): void {
  if (rows.length === 1) {
    processOneLanding(cwd, rows[0]!, options)
    return
  }
  claimLandingRows(rows)
  const { project, repoRoot } = registeredProject(cwd)
  const trunk = typeof project.settings.trunk === 'string' ? project.settings.trunk.trim() : ''
  const trunkOid = git(repoRoot, ['rev-parse', `refs/heads/${trunk}^{commit}`])
  const groupBranch = `orch/land-group-${rows[0]!.id}`
  const groupPath = join(repoRoot, '.claude', 'worktrees', groupBranch.replace(/\//g, '-'))
  mkdirSync(dirname(groupPath), { recursive: true })
  if (existsSync(groupPath)) gitOk(repoRoot, ['worktree', 'remove', '--force', groupPath])
  git(repoRoot, ['worktree', 'add', '-b', groupBranch, groupPath, trunkOid])
  const cleanup = () => {
    gitOk(repoRoot, ['worktree', 'remove', '--force', groupPath])
    gitOk(repoRoot, ['branch', '-D', groupBranch])
    gitOk(repoRoot, ['worktree', 'prune'])
  }
  let fastForwarded = false
  try {
    const started = Date.now()
    const ranges = rebaseBranchesOntoTrunk(repoRoot, groupPath, trunkOid, rows)
    const authorizations: ReturnType<typeof authorizeLanding>[] = []
    for (const { row, from, to } of ranges) {
      const flags = flagsOf(row)
      try {
        authorizations.push(authorizeLanding(
          project, repoRoot, groupPath, row.branch, to, from, undefined, flags.unreviewed,
          { worktree: ensureLandingWorktree(repoRoot, row.branch),
            tip: row.tip ?? git(repoRoot, ['rev-parse', `refs/heads/${row.branch}^{commit}`]) },
        ))
      } catch (error) {
        throw new MergeGroupMemberFailure(
          row.branch, error instanceof Error ? error.message : String(error),
          reviewRework(error),
        )
      }
    }
    const taskKeys = ranges.flatMap(({ row }) => row.branch.match(/[A-Z]+-\d+/)?.[0] ?? [])
    const allocated = allocateLandingJournals(groupPath, trunkOid, undefined, taskKeys)
    if (allocated.length) {
      console.log(`allocated journal ${allocated.map((row) => `${row.from} -> ${row.to}`).join(', ')}`)
    }
    const tip = git(groupPath, ['rev-parse', '--verify', 'HEAD^{commit}'])
    allocationParentIfMechanical(repoRoot, tip, rows[0]!.branch)
    git(groupPath, ['checkout', '-B', groupBranch, tip])
    const guard = prepareSharedRefGuard(groupPath)
    try {
      runGate(project, groupPath, groupBranch, guard)
    } catch (error) {
      cleanup()
      bisectMergeGroup(cwd, rows, options, error)
      return
    }
    appendStep(rows[0]!.id, 'merge-group-gate', Date.now() - started)
    withProjectLock(repoRoot, LANDING_LOCK, { session: sessionId(), what: `group ${rows[0]!.id}` }, () => {
      verifyGuardBeforeFastForward(repoRoot)
      assertMainCheckoutOnTrunk(repoRoot, trunk)
      const current = git(repoRoot, ['rev-parse', `refs/heads/${trunk}^{commit}`])
      if (current !== trunkOid) {
        throw new MergeGroupTrunkMoved(trunkOid, current)
      }
      for (const { row, from, to } of ranges) {
        refuseOrWaitLiveRuns(
          project, repoRoot, groupPath, from, to, flagsOf(row).strandLive,
          options.timeoutMs ?? LANDING_LOCK_TIMEOUT_MS, row.id,
        )
      }
      git(repoRoot, ['update-ref', `refs/heads/${trunk}`, tip, trunkOid])
      fastForwarded = true
    }, options.timeoutMs ?? LANDING_LOCK_TIMEOUT_MS)
    for (const row of rows) {
      const authorization = authorizations[rows.indexOf(row)]!
      recordLandingOverride(authorization.override)
      recordReviewCarry(authorization.carry)
      writeTransaction(() => {
        db().query(
          `UPDATE landing SET tip=?,trunk_before=?,status='landed',finished_at=?,claim_pid=NULL,claim_session=NULL WHERE id=?`,
        ).run(tip, trunkOid, nowIso(), row.id)
      })
      const landedPaths = git(repoRoot, ['diff', '--name-only', `${trunkOid}..${tip}`]).split('\n').filter(Boolean)
      recordOverlapInvalidations(project, repoRoot, landedPaths, row.branch, row.id)
    }
    try {
      const installStarted = Date.now()
      installLandedPackages(project, trunkOid, tip)
      for (const row of rows) appendStep(row.id, 'install', Date.now() - installStarted)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const row of rows) {
        db().query(`UPDATE landing SET status='install_failed',error=?,finished_at=?,claim_pid=NULL,claim_session=NULL WHERE id=?`)
          .run(message, nowIso(), row.id)
      }
      throw error
    }
    try {
      const migrateStarted = Date.now()
      const output = migrateLandedJournals(project, trunkOid, tip)
      for (const row of rows) appendStep(row.id, 'migrate', Date.now() - migrateStarted, output)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const row of rows) {
        db().query(`UPDATE landing SET status='install_failed',error=?,finished_at=?,claim_pid=NULL,claim_session=NULL WHERE id=?`).run(message, nowIso(), row.id)
      }
      throw error
    }
    console.log(`landed merge-group of ${rows.map((row) => row.branch).join(', ')} at ${tip}`)
  } catch (error) {
    if (error instanceof MergeGroupMemberFailure) {
      const failed = rows.find((row) => row.branch === error.branch)
      writeTransaction(() => {
        for (const row of rows) {
          if (row.id === failed?.id) {
            db().query(
              `UPDATE landing SET status='refused',error=?,finished_at=?,claim_pid=NULL,claim_session=NULL WHERE id=?`,
            ).run(
              `${error.message}\ninvariant: a conflicting merge-group member is refused without stranding its peers` +
              `\ncleared by: orch land ${row.branch}`,
              nowIso(), row.id,
            )
          } else {
            db().query(
              `UPDATE landing SET status='queued',claim_pid=NULL,claim_session=NULL WHERE id=?`,
            ).run(row.id)
          }
        }
        markReviewsOutdated(reviewRework(error))
      })
      return
    }
    if (!(error instanceof MergeGroupTrunkMoved)) {
      if (!fastForwarded) {
        const message = error instanceof Error ? error.message : String(error)
        writeTransaction(() => {
          for (const row of rows) {
            db().query(
              `UPDATE landing SET status='refused',error=?,finished_at=?,claim_pid=NULL,claim_session=NULL WHERE id=?`,
            ).run(
              `${message}\ninvariant: a merge-group member never remains running after processing returns` +
              `\ncleared by: orch land ${row.branch}`,
              nowIso(), row.id,
            )
          }
        })
      }
      throw error
    }
    tryWriteContention({
      resourceKind: 'trunk', resourceKey: project.name, eventKind: 'retry',
      cause: `${trunk} moved from ${error.from} to ${error.to}`,
      landingId: rows[0]!.id,
    })
    if (losses + 1 >= 3) {
      const refusal = namedError(
        `refusing merge-group: ${trunk} moved during three gated attempts`,
        INVARIANT_LOCK_SCOPE,
        `orch land <branch>`,
      )
      for (const row of rows) {
        db().query(
          `UPDATE landing SET status='refused',error=?,finished_at=?,claim_pid=NULL,claim_session=NULL WHERE id=?`,
        ).run(refusal.message, nowIso(), row.id)
      }
      throw refusal
    }
    cleanup()
    console.log(`${trunk} moved during merge-group gate; rebuilding and re-gating the group`)
    processMergeGroup(cwd, rows, options, losses + 1)
  } finally {
    cleanup()
  }
}

function bisectMergeGroup(
  cwd: string, rows: LandingRow[],
  options: { timeoutMs?: number; unreviewed?: string; strandLive?: string },
  error: unknown,
): void {
  if (rows.length === 1) {
    const message = error instanceof Error ? error.message : String(error)
    const at = nowIso()
    writeTransaction(() => {
      db().query(`UPDATE landing SET status='refused',error=?,finished_at=?,claim_pid=NULL,claim_session=NULL WHERE id=?`)
        .run(message, at, rows[0]!.id)
      markReviewsOutdated(reviewRework(error), at)
    })
    tryWriteContention({
      resourceKind: 'trunk', resourceKey: rows[0]!.project, eventKind: 'refusal',
      cause: message, landingId: rows[0]!.id,
    })
    console.log(`merge-group isolated culprit ${rows[0]!.branch}`)
    return
  }
  const mid = Math.ceil(rows.length / 2)
  const left = rows.slice(0, mid)
  const right = rows.slice(mid)
  for (const row of right) db().query(`UPDATE landing SET status='queued',claim_pid=NULL,claim_session=NULL WHERE id=? AND status='running'`).run(row.id)
  try {
    processMergeGroup(cwd, left, options)
  } catch (leftError) {
    bisectMergeGroup(cwd, left, options, leftError)
    return
  }
  try {
    processMergeGroup(cwd, right, options)
  } catch (rightError) {
    bisectMergeGroup(cwd, right, options, rightError)
  }
}

function spawnDrain(repoRoot: string): void {
  const cli = new URL('./cli.ts', import.meta.url).pathname
  const child = spawn(process.execPath, [cli, 'land', '--drain'], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_DEPTH: '0' },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

function reviewRework(error: unknown): { id: number; reason: string }[] {
  const rows = (error as { reviewRework?: unknown } | null)?.reviewRework
  return Array.isArray(rows) ? rows as { id: number; reason: string }[] : []
}

function markReviewsOutdated(
  reviews: { id: number; reason: string }[],
  at: string = nowIso(),
): void {
  for (const review of reviews) {
    db().query('UPDATE review SET outdated_at=COALESCE(outdated_at,?), outdated_reason=? WHERE id=?')
      .run(at, review.reason, review.id)
  }
}

function recordRefusedLanding(project: Project, branch: string, error: unknown): void {
  const at = nowIso()
  const message = error instanceof Error ? error.message : String(error)
  writeTransaction(() => {
    db().query(
      `INSERT INTO landing
         (project,project_id,branch,status,error,session_id,started_at,finished_at,requested_at)
       VALUES (?,?,?,'refused',?,?,?,?,?)`,
    ).run(project.name, project.id, branch, message, sessionId(), at, at, at)
    markReviewsOutdated(reviewRework(error), at)
  })
}

function assertEnqueuePreconditions(
  repoRoot: string, project: Project, branch: string,
  options: { unreviewed?: string; runId?: number },
): ReturnType<typeof authorizeLanding> | null {
  const trunk = typeof project.settings.trunk === 'string' ? project.settings.trunk.trim() : ''
  assertNotProductionBranch(project, trunk, branch)
  if (!gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
    throw namedError(
      `branch ${branch} does not exist in project ${project.name}`,
      INVARIANT_LOCK_SCOPE,
      `git show-ref --verify refs/heads/${branch}`,
    )
  }
  const recordedBlock = recordedLandingBlock(project.name, branch, options.runId)
  if (recordedBlock && !existsSync(recordedBlock.worktree)) {
    throw namedError(
      `refusing to land ${branch}: ${recordedBlock.detail}`,
      recordedBlock.invariant,
      recordedBlock.command,
    )
  }
  const worktree = worktreesForBranch(repoRoot, branch).find((path) => existsSync(path))
  if (!worktree) return null
  assertLandingWorktreeReady(worktree, branch)
  return null
}

export function drainQueue(
  cwd: string,
  options: { timeoutMs?: number; unreviewed?: string; strandLive?: string; untilId?: number } = {},
): void {
  writableDb()
  const { project, repoRoot } = registeredProject(cwd)
  const lockTimeout = options.timeoutMs ?? LANDING_LOCK_TIMEOUT_MS
  const waitDeadline = Date.now() + lockTimeout
  while (true) {
    const picked = withProjectLock(
      repoRoot, QUEUE_LOCK, { session: sessionId(), what: `drain ${project.name}` },
      (): 'done' | 'wait' | LandingRow[] => {
        reclaimDeadLandingClaims(project.name)
        refuseChangedEnqueuedTips(project.name, repoRoot)
        if (options.untilId) {
          const row = db().query('SELECT status FROM landing WHERE id=?').get(options.untilId) as
            { status: string } | null
          if (row && !['queued', 'running'].includes(row.status)) return 'done'
        }
        const queued = queuedLandings(project.name).filter((row) =>
          gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${row.branch}`]))
        if (queued.length) {
          // A waiter drains its OWN row first. Picking queued[0] let a second
          // lander claim the first lander's row while the first sat in the wait
          // branch on its own, so the second's row was never gated: two
          // concurrent landings hung until their bound (DEV-380, four refused
          // landings on 2026-09-08). Without untilId the whole queue is a group.
          // A waiter drains exactly its own row. Grouping older queued rows
          // in with it (review 368's FIFO refinement) let the second of two
          // --wait landers absorb the first's row into one merge group
          // whenever it won the pick, so one gate ran under a group branch
          // while each lander expected its own branch gated: measured on
          // 2026-09-08 as a full-bound hang under a loaded gate and a pass
          // alone. Ordering is not an invariant here; the landing lock
          // serialises the fast-forward and a moved trunk re-gates. A waiter
          // whose row is gone takes queued[0].
          const own = options.untilId ? queued.find((row) => row.id === options.untilId) : undefined
          const group = !options.untilId && queued.length >= 2 ? queued : [own ?? queued[0]!]
          claimLandingRows(group)
          return group
        }
        if (!options.untilId) return 'done'
        const row = db().query('SELECT status FROM landing WHERE id=?').get(options.untilId) as
          { status: string } | null
        if (row?.status === 'running') return 'wait'
        if (row?.status === 'queued') {
          throw new Error(`landing ${options.untilId} stuck ${row.status} with an empty queue`)
        }
        return 'done'
      },
      lockTimeout,
    )
    if (picked === 'done') return
    if (picked === 'wait') {
      if (Date.now() >= waitDeadline) {
        const row = db().query(
          'SELECT claim_pid,claim_session FROM landing WHERE id=?',
        ).get(options.untilId!) as { claim_pid: number | null; claim_session: string | null } | null
        throw new Error(
          `timed out waiting for landing ${options.untilId}, claimed by pid ${row?.claim_pid ?? 'unknown'}` +
          ` (session ${row?.claim_session ?? 'unknown'}); inspect with orch land --status`,
        )
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
      continue
    }
    try {
      if (picked.length >= 2) processMergeGroup(cwd, picked, options)
      else processOneLanding(cwd, picked[0]!, options)
    } catch (error) {
      if (options.untilId) {
        const row = db().query('SELECT status FROM landing WHERE id=?').get(options.untilId) as
          { status: string } | null
        if (row?.status === 'landed' || row?.status === 'install_failed') return
        if (row?.status === 'refused' || row?.status === 'rebase_required') throw error
        continue
      }
      const message = error instanceof Error ? error.message : String(error)
      console.error(`orch land --drain: ${message}`)
    }
  }
}

export function land(
  cwd: string,
  branch: string,
  options: {
    timeoutMs?: number; message?: string; unreviewed?: string; runId?: number
    queue?: boolean; wait?: boolean; strandLive?: string; keepCheckpoints?: boolean
  } = {},
): string {
  writableDb()
  const { project, repoRoot } = registeredProject(cwd)
  try {
    assertEnqueuePreconditions(repoRoot, project, branch, options)
  } catch (error) {
    recordRefusedLanding(project, branch, error)
    throw error
  }
  const trunk = typeof project.settings.trunk === 'string' ? project.settings.trunk.trim() : ''
  const requestedAt = nowIso()
  const paths = trunk ? pathSetOf(repoRoot, trunk, branch) : []
  const enqueuedTip = git(repoRoot, ['rev-parse', `refs/heads/${branch}^{commit}`])
  const landing = writeTransaction(() => {
    const row = db().query(
      `INSERT INTO landing
       (project,project_id,branch,tip,status,session_id,started_at,requested_at,path_set,steps)
     VALUES (?,?,?,?,'queued',?,?,?,?,?) RETURNING id`,
    ).get(
      project.name, project.id, branch, enqueuedTip, sessionId(), requestedAt, requestedAt,
      JSON.stringify(paths),
      JSON.stringify([{
        name: '_flags',
        ...(options.unreviewed ? { unreviewed: options.unreviewed } : {}),
        ...(options.strandLive ? { strandLive: options.strandLive } : {}),
        ...(options.message ? { message: options.message } : {}),
        ...(options.keepCheckpoints ? { keepCheckpoints: true } : {}),
      }]),
    ) as { id: number }
    return row
  })
  const ahead = queuedLandings(project.name).filter((row) => row.id < landing.id).length
  const position = ahead + 1
  console.log(`queued ${branch} at position ${position} (landing ${landing.id})`)
  const wait = options.wait !== false
  if (!wait) {
    if (!projectLockState(repoRoot, QUEUE_LOCK).holder) spawnDrain(repoRoot)
    return `queued ${branch} at position ${position}`
  }
  drainQueue(cwd, { ...options, untilId: landing.id })
  const row = db().query('SELECT status, tip, error FROM landing WHERE id=?').get(landing.id) as
    { status: string; tip: string | null; error: string | null }
  if (row.error) throw new Error(row.error)
  if (row.status === 'landed') return row.tip ?? ''
  throw new Error(`landing ${landing.id} ${row.status}`)
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
  const queue = projectLockState(repoRoot, QUEUE_LOCK)
  const age = (since: string) => `${Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000))}s`
  const holder = state.holder
    ? `held by session ${state.holder.session ?? 'unknown'}, pid ${state.holder.pid}, ` +
      `landing ${state.holder.what}, for ${age(state.holder.since)}`
    : 'free'
  const queueHolder = queue.holder
    ? `held by session ${queue.holder.session ?? 'unknown'}, pid ${queue.holder.pid}, ` +
      `${queue.holder.what}, for ${age(queue.holder.since)}`
    : 'free'
  const waiters = state.waiters.length
    ? state.waiters.map((w) =>
        `  session ${w.session ?? 'unknown'}, pid ${w.pid}, landing ${w.what}, waiting ${age(w.since)}`).join('\n')
    : '  none'
  const queued = db().query(
    `SELECT id, branch, status, session_id, path_set FROM landing
      WHERE project=? AND status IN ('queued','running','rebase_required') ORDER BY id`,
  ).all(project.name) as {
    id: number; branch: string; status: string; session_id: string | null; path_set: string | null
  }[]
  const queueText = queued.length
    ? queued.map((row) => {
        const paths = row.path_set ? (JSON.parse(row.path_set) as string[]).join(', ') : '(none)'
        return `  ${row.status} landing ${row.id} ${row.branch} session ${row.session_id ?? 'unknown'} paths ${paths}`
      }).join('\n')
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
    `\nqueue lock: ${queueHolder}\nqueue:\n${queueText}` +
    (postStep.length ? `\n${postStep.join('\n')}` : '') +
    `\ninvalidated today:\n${invalidationText}`
}
