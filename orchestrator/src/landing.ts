import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { db, nowIso, sessionId } from './db.ts'
import { formatGitLocks } from './git-locks.ts'
import { projectAt, type Project } from './projects.ts'
import {
  prepareSharedRefGuard, projectLockState, repoRootOf, withProjectLock,
  type SharedRefGuardEnvironment,
} from './worktree.ts'

const LANDING_LOCK = 'landing'
const LANDING_LOCK_TIMEOUT_MS = 5 * 60_000

function git(
  cwd: string, args: string[], guard?: SharedRefGuardEnvironment,
): string {
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: { ...process.env, ...guard }, stdout: 'pipe', stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString().trim() || `exit ${p.exitCode}`}`)
  }
  return p.stdout.toString().trim()
}

function gitOk(cwd: string, args: string[], guard?: SharedRefGuardEnvironment): boolean {
  return Bun.spawnSync(['git', ...args], {
    cwd, env: { ...process.env, ...guard }, stdout: 'ignore', stderr: 'ignore',
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

function runGate(project: Project, worktree: string, guard: SharedRefGuardEnvironment): void {
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
  console.log(`gate ${project.name}: ${gate}`)
  const p = Bun.spawnSync(['sh', '-lc', gate], {
    cwd: worktree, env: { ...process.env, ...guard }, stdout: 'inherit', stderr: 'inherit',
  })
  if (p.exitCode !== 0) throw new Error(`landing gate failed with exit ${p.exitCode}: ${gate}`)
  const after = git(worktree, ['status', '--porcelain=v1', '--untracked-files=all'], guard)
  if (after) {
    throw new Error(`landing gate changed the worktree; its result was not the commit being landed:\n${after}`)
  }
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
  runGate(project, worktree, guard)
  return tip
}

type ReviewCoverage = {
  id: number
  lenses: { lens: string; runId: number; tree: string | null }[]
}

function completedReviews(project: string): ReviewCoverage[] {
  const rows = db().query(
    `SELECT r.id, rl.lens, rl.run_id, rl.reviewed_tree
       FROM review r
       JOIN review_lens rl ON rl.review_id=r.id
      WHERE r.completed_at IS NOT NULL AND EXISTS (
        SELECT 1 FROM review_lens project_lens
        JOIN run project_run ON project_run.id=project_lens.run_id
        WHERE project_lens.review_id=r.id AND project_run.repo=?
      )
      ORDER BY r.id, rl.id`,
  ).all(project) as { id: number; lens: string; run_id: number; reviewed_tree: string | null }[]
  const grouped = new Map<number, ReviewCoverage>()
  for (const row of rows) {
    const review = grouped.get(row.id) ?? { id: row.id, lenses: [] }
    review.lenses.push({ lens: row.lens, runId: row.run_id, tree: row.reviewed_tree })
    grouped.set(row.id, review)
  }
  return [...grouped.values()]
}

function coverageText(project: string, candidateTree: string): string {
  const reviews = completedReviews(project)
  const lines = reviews.length
    ? reviews.flatMap((review) => [
        `review ${review.id} (${review.lenses.length > 0 &&
          review.lenses.every((lens) => lens.tree === candidateTree)
          ? 'covers' : 'does not cover'}):`,
        ...review.lenses.map((lens) =>
          `  ${lens.lens} (run ${lens.runId}): ${lens.tree ?? 'NULL'} ` +
          (lens.tree === candidateTree ? '(matches)' : '(MISMATCH)')),
      ])
    : ['  none']
  return `current tip tree: ${candidateTree}\n${lines.join('\n')}`
}

function requireReviewCoverage(project: Project, repoRoot: string, tip: string): string {
  const candidateTree = git(repoRoot, ['rev-parse', `${tip}^{tree}`])
  const reviews = completedReviews(project.name)
  if (reviews.some((review) => review.lenses.length > 0 &&
      review.lenses.every((lens) => lens.tree === candidateTree))) return candidateTree
  throw new Error(
    `refusing to land unreviewed content\ncandidate tree: ${candidateTree}\n` +
    `${coverageText(project.name, candidateTree)}\n` +
    'A rebase onto moved trunk changes the tree, so re-run the review lenses from the rebased branch ' +
    '(with --carry) and record them.',
  )
}

function authorizeLanding(
  project: Project, repoRoot: string, branch: string, tip: string, unreviewed?: string,
): { project: string; branch: string; tip: string; tree: string; reason: string } | null {
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
    return { project: project.name, branch, tip, tree, reason }
  }
  requireReviewCoverage(project, repoRoot, tip)
  return null
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
      const override = authorizeLanding(project, repoRoot, branch, optimisticTip, options.unreviewed)
      fastForward(repoRoot, worktree, branch, trunk, optimisticTip, recordedTrunk, guard)
      recordLandingOverride(override)
      console.log(`landed ${branch} at ${optimisticTip} onto ${trunk} (optimistic gate remained current)`)
      return optimisticTip
    }

    console.log(`${trunk} moved from ${recordedTrunk} to ${currentTrunk}; re-gating ${branch} under the landing lock`)
    const serializedTip = rebaseAndGate(
      project, repoRoot, worktree, branch, trunk, currentTrunk, guard,
    )
    const override = authorizeLanding(project, repoRoot, branch, serializedTip, options.unreviewed)
    fastForward(repoRoot, worktree, branch, trunk, serializedTip, currentTrunk, guard)
    recordLandingOverride(override)
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
  const tree = git(cwd, ['rev-parse', `${tip}^{tree}`])
  return `${project.name} landing lock: ${holder}\nwaiters:\n${waiters}\n${formatGitLocks(repoRoot)}` +
    `\nreview coverage for ${branch}:\n${coverageText(project.name, tree)}`
}
