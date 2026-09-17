// concern: worktree-remove
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { git, gitOk, gitRaw, targetGitEnvironment } from '../git/git-environment.ts'
import { projectAt, resolvedWorktreeTool, type WorktreeTool } from '../project/projects.ts'
import {
  databaseDroppedByTeardown,
  dbNameFor,
  type Recipe,
  type StepResult,
  teardownRecipe,
} from '../recipe/recipe.ts'
import { teardownTrackedRecipe } from '../recipe/tracked-recipe.ts'
import { markedWorktreeRunId, removeSharedRefGuard } from '../resources/ref-guard.ts'
import { recipePortClaimForRun, settleDatabaseClaim } from '../resources/resource-claims.ts'
import { extractWorktree, ORCH_RUN_MARKER } from './worktree-attribution.ts'
import { runShellTool } from './worktree-tool.ts'
import type { Worktree } from './worktree-types.ts'

function portFor(runId: number): number {
  return 21000 + (runId % 4000)
}

export type Changes = {
  /** The unified diff against the run's trunk merge-base, including files never added. */
  diff: string
  /** Paths the worker touched, so scope can be checked without reading the diff. */
  files: string[]
  insertions: number
  deletions: number
  /** The commit used as the lower end of the diff. */
  since: string
  /** The configured trunk, or `main` when the register has none. */
  trunk: string
  /** Whether trunk came from the project register. */
  trunkConfigured: boolean
}

function teardownBuiltInRecipe(
  recipe: Recipe,
  w: Worktree,
  runId: number,
): { ok: true } | { ok: false; step: string; detail: string } {
  const dbName = dbNameFor(w.repoRoot.split('/').pop() ?? 'app', runId)
  const treeExists = existsSync(w.path)
  const temporaryCwd = treeExists ? null : mkdtempSync(join(tmpdir(), 'orch-teardown-'))
  const processCwd = temporaryCwd ?? w.path
  let teardown: StepResult[]
  try {
    const claimedPort = recipe.serve ? recipePortClaimForRun(db(), runId) : null
    // A recipe tree with no port claim predates ledger allocation. Only those
    // legacy trees derive the teardown port from their run id.
    const teardownPort = claimedPort ?? (recipe.serve ? portFor(runId) : null)
    teardown = teardownRecipe(recipe, w.path, processCwd, dbName, String(teardownPort ?? ''))
  } finally {
    if (temporaryCwd) rmSync(temporaryCwd, { recursive: true, force: true })
  }
  for (const step of teardown) {
    if (!step.ok) console.error(`orch: ${step.step} failed: ${step.detail.slice(-200)}`)
  }
  const firstFailure = teardown.find((step) => !step.ok)
  if (!recipe.database || recipe.database.kind === 'none') {
    return firstFailure
      ? { ok: false, step: firstFailure.step, detail: firstFailure.detail }
      : { ok: true }
  }
  const provider = recipe.database.kind
  const databaseDropped = databaseDroppedByTeardown(provider, teardown)
  writeTransaction(() => {
    settleDatabaseClaim(db(), {
      allocationKey: `${provider}:${dbName}`,
      databaseDropped,
      settledAt: nowIso(),
      detail: databaseDropped
        ? `${provider} teardown released ${dbName}`
        : `${provider} teardown failed; ${dbName} retained`,
    })
  })
  return firstFailure
    ? { ok: false, step: firstFailure.step, detail: firstFailure.detail }
    : { ok: true }
}

/**
 * What the worker actually changed.
 *
 * `git add -A` first, then diff against the base. Staging is what makes
 * UNTRACKED files visible: a plain `git diff` shows nothing for a brand new
 * file, so a worker whose whole job was to add one would report an empty
 * change set and look like it had done nothing. That is the single most likely
 * way this could silently under-report, so it is handled first rather than
 * discovered later.
 *
 * Staging is also what makes a mixed committed/uncommitted result one complete
 * patch. The comparison is against the run tip's merge-base with current
 * trunk, so commits on the run branch and working-tree changes are captured
 * together without attributing commits that subsequently landed on trunk.
 */
export function changesIn(w: Worktree, sinceBase = false): Changes {
  git(['add', '-A'], w.path)
  const configuredTrunk = projectAt(w.repoRoot)?.settings.trunk?.trim()
  const trunk = configuredTrunk || 'main'
  const mergeBase = sinceBase ? w.base : gitOk(['merge-base', 'HEAD', trunk], w.path)
  if (!mergeBase && configuredTrunk) {
    throw new Error(`cannot find merge-base between the run tip and trunk ${trunk}`)
  }
  // Unregistered scratch repositories predate the register and do not all call
  // their initial branch `main`. Their only truthful fallback is the recorded
  // base; registered projects must resolve their declared trunk above.
  const since = mergeBase ?? w.base
  // Raw: this is a patch, and `git apply` counts its bytes.
  const diff = gitRaw(['diff', '--cached', since], w.path)
  const names = gitOk(['diff', '--cached', '--name-only', since], w.path) ?? ''
  const stat = gitOk(['diff', '--cached', '--numstat', since], w.path) ?? ''

  let insertions = 0
  let deletions = 0
  for (const line of stat.split('\n')) {
    const [add, del] = line.split('\t')
    // A binary file reports '-' for both. Counting those as zero is right:
    // they are real changes and they have no line count, and inventing one
    // would put noise into a number the fidelity check reads.
    insertions += Number(add) || 0
    deletions += Number(del) || 0
  }
  return {
    diff,
    files: names ? names.split('\n').filter(Boolean) : [],
    insertions,
    deletions,
    since,
    trunk,
    trunkConfigured: Boolean(configuredTrunk),
  }
}

/**
 * Delete a worktree and its branch.
 *
 * `--force` because a worker may leave staged or unstaged changes even when it
 * also committed. Unique commits are protected separately by `unmergedBranch`:
 * ordinary discard keeps their branch and names `--force`, while a run that
 * committed nothing still discards routinely. A removal that silently fails
 * leaves changes on disk with nothing pointing at them.
 *
 * Never called automatically on failure. A failed implementation run is the
 * case where the half-finished tree is most worth reading, and a cleanup that
 * ran on error would destroy the evidence at precisely the moment it mattered.
 * `orch discard` is a decision someone makes.
 */
/**
 * Take one down with the project's own tool, so its INFRASTRUCTURE goes too.
 *
 * The directory is the cheap part. What actually accumulates is everything the
 * setup provisioned behind it — a database of up to a few gigabytes, a
 * container, a port reservation, a queue worker — and `git worktree remove`
 * knows about none of that. Removing the directory without calling the tool is
 * how a machine fills up with databases nobody can name.
 */
function removeWithTool(
  tool: WorktreeTool,
  w: Worktree,
  forceOrchTree = false,
  keepBranch = false,
  runId?: number,
): { removed: boolean; detail: string; output?: string } {
  const name = w.path.split('/').pop() ?? w.path
  const branchBefore = branchTip(w.repoRoot, w.branch)
  const uniqueBefore = unmergedBranch(w.repoRoot, w.branch, null)

  // A recipe-built tree is torn down the same way it was made: bottega
  // provisioned the database, so bottega drops it. Done BEFORE the directory
  // goes, because a compose file that lives in the worktree cannot bring
  // anything down once the worktree has been deleted.
  if (!tool.remove) {
    return removeWithoutCommand(tool, w, keepBranch, runId)
  }

  const vars: Record<string, string> = { name, path: w.path }
  if (w.branch) vars.branch = w.branch
  const r = runShellTool(tool.remove, vars, w.repoRoot)
  if (r.ok && !existsSync(w.path)) {
    const branchAfter = branchTip(w.repoRoot, w.branch)
    if (
      branchAfter !== null &&
      branchAfter !== branchBefore &&
      (uniqueBefore !== null || !keepBranch)
    ) {
      return {
        removed: false,
        detail:
          branchBefore === null
            ? `project remove tool created unprotected branch ${w.branch} at ${branchAfter}; it was left in place`
            : uniqueBefore
              ? `project remove tool moved unique branch ${w.branch} from ${branchBefore} to ${branchAfter}; it was left in place`
              : `project remove tool moved unprotected branch ${w.branch} from ${branchBefore} to ${branchAfter}; it was left in place`,
        ...(r.out ? { output: r.out } : {}),
      }
    }
    const reconciled = removeWorktree(w, keepBranch)
    return { ...reconciled, ...(r.out ? { output: r.out } : {}) }
  }

  // The marker is the proof that orch made and owns this disposable checkout.
  // A project's removal guard can therefore be forced only when the operator
  // explicitly asked and this exact proof is still present. Names and branch
  // templates also recognise old trees for sweep, but are deliberately not
  // strong enough evidence for destructive fallback here.
  if (forceOrchTree && existsSync(join(w.path, ORCH_RUN_MARKER))) {
    return removeWorktree(w, keepBranch)
  }

  /**
   * A PROJECT'S REFUSAL IS FINAL UNLESS THE OPERATOR FORCES AN ORCH-OWNED TREE.
   *
   * This used to fall through to plain `git worktree remove --force` when the
   * tool exited non-zero, which is the ordinary orchestrator mistake and the
   * dangerous one: the refusals fire in exactly the case where the work is
   * irreplaceable. One project's tool will not remove a tree with uncommitted changes
   * without `--force`, and uses `git branch -d` so an unmerged branch survives
   * — both deliberate, because a leftover branch is recoverable and a deleted
   * one is not. Orch ownership, proved by the marker, is what permits an
   * operator-requested forced fallback; whether the worker committed is no
   * longer part of that proof. A dirty tree it left behind may still be the
   * ONLY copy of work it did not commit.
   *
   * Forcing past that for an unmarked tree is the same class of act as a worker
   * pushing its own change: a destructive decision belonging to the architect,
   * taken by machinery on their behalf. So the refusal is surfaced instead. A
   * leftover worktree costs a directory and a database name, and the project's
   * own sweep reclaims the database later anyway.
   */
  return {
    removed: false,
    detail:
      `${w.path} was NOT removed — the project's own tool refused, and orch will not ` +
      `force past that:\n${r.out.slice(-600) || `exit code from ${tool.remove}`}\n\n` +
      `Those refusals guard uncommitted work and unmerged branches. Inspect and resolve ` +
      `the protected work with the project's own tooling, then run orch discard again. ` +
      `--force will not override a project tool's refusal unless the tree carries orch's ` +
      `${ORCH_RUN_MARKER} ownership marker.`,
  }
}

function removeWithoutCommand(
  tool: WorktreeTool,
  w: Worktree,
  keepBranch: boolean,
  runId?: number,
): { removed: boolean; detail: string } {
  if (tool.recipePath) {
    if (runId === undefined)
      return {
        removed: false,
        detail:
          'tracked recipe tree has no recorded recipe snapshot; teardown cannot be established',
      }
    return teardownTrackedRecipe({
      runId,
      worktree: w,
      remove: () => removeWorktree(w, keepBranch),
    })
  }
  if (!tool.recipe || runId === undefined) return removeWorktree(w, keepBranch)
  const teardown = teardownBuiltInRecipe(tool.recipe, w, runId)
  return teardown.ok
    ? removeWorktree(w, keepBranch)
    : {
        removed: false,
        detail: `recipe teardown failed at "${teardown.step}": ${teardown.detail.slice(-200)}`,
      }
}

export function removeReadOnlyTree(
  tool: WorktreeTool,
  w: Worktree,
  keepBranch = false,
): { removed: boolean; detail: string; output?: string } {
  if (!tool.readonly_remove) return removeWorktree(w, keepBranch)
  const result = runShellTool(tool.readonly_remove, { path: w.path }, w.repoRoot)
  if (!result.ok) {
    return {
      removed: false,
      detail:
        `${w.path} was NOT removed — the project's read-only remove tool refused:\n` +
        `${result.out.slice(-600) || `exit code from ${tool.readonly_remove}`}`,
    }
  }
  const reconciled = removeWorktree(w, keepBranch)
  return result.out ? { ...reconciled, output: result.out } : reconciled
}

function mintedBranchOwnedBy(w: Worktree, runId?: number): string | null {
  if (runId !== undefined) {
    try {
      const row = db().query('SELECT minted_branch FROM run WHERE id=?').get(runId) as {
        minted_branch: string | null
      } | null
      if (row) return row.minted_branch
    } catch {
      /* a store mid-migrate has no minted_branch yet */
    }
  }
  return w.mintedBranch ?? null
}

/** Remove a tree through the lifecycle declared by its registered project. */
export function removeFor(
  w: Worktree,
  repoRoot: string,
  forceOrchTree = false,
  keepBranch = false,
  runId?: number,
  forceUnmerged = false,
): { removed: boolean; detail: string; output?: string } {
  // The marker identifies who created a tree; it does not transfer that run's
  // branch ownership to a later attacher. Cleanup names only the discarding
  // run's minted branch.
  const owningRunId = runId ?? markedWorktreeRunId(w.path)
  if (existsSync(w.path)) {
    const extracted = extractWorktree(w.path, owningRunId)
    if (!extracted.ok) return { removed: false, detail: extracted.detail }
  }
  const minted = mintedBranchOwnedBy(w, runId)
  // Unminted: the git branch is not ours to name to a project tool. Pass the
  // tree only. Minted: the tool receives that branch name, never ''.
  const owned = { ...w, branch: minted ?? '' }
  const project = projectAt(repoRoot)
  const tool = resolvedWorktreeTool(project)
  const retainBranch =
    keepBranch || !minted || (!forceUnmerged && unmergedBranch(repoRoot, minted, null) !== null)
  let result: { removed: boolean; detail: string; output?: string }
  if (w.source === 'readonly_recipe') {
    const removed = removeReadOnlyTree(tool ?? {}, owned, retainBranch)
    result = removed.output
      ? { ...removed, output: `${project!.name} readonly remove:\n${removed.output}` }
      : removed
  } else {
    const projectOwned = w.source === 'recipe' || (w.source === undefined && Boolean(tool))
    const removed: { removed: boolean; detail: string; output?: string } =
      tool && projectOwned
        ? removeWithTool(tool, owned, forceOrchTree, retainBranch, runId)
        : removeWorktree(owned, retainBranch)
    result = removed.output
      ? { ...removed, output: `${project!.name} remove:\n${removed.output}` }
      : removed
  }
  if (result.removed && owningRunId !== undefined && owningRunId !== null) {
    removeSharedRefGuard(repoRoot, owningRunId)
  }
  return result
}

/** Reclaim orphans the project knows about — databases, containers, metadata. */
export function sweepWithTool(
  tool: WorktreeTool,
  repoRoot: string,
): { ok: boolean; out: string; exitCode: number | null } | null {
  if (!tool.sweep) return null
  const result = runShellTool(tool.sweep, {}, repoRoot)
  return { ok: result.ok, out: result.out, exitCode: result.exitCode }
}

export function removeWorktree(
  w: Worktree,
  keepBranch = false,
): { removed: boolean; detail: string } {
  const deleteBranch = Boolean(w.branch) && !keepBranch
  // Never prune the repository; remove only this worktree's own record.
  // Already gone is a SUCCESS, not an error. A worktree deleted by hand, or one
  // in a scratch repository that has since been cleaned up, leaves a database
  // pointer that ought to be clearable — refusing would strand it for ever.
  if (!existsSync(w.path)) {
    gitOk(['worktree', 'remove', '--force', w.path], w.repoRoot)
    if (deleteBranch) gitOk(['branch', '-D', w.branch], w.repoRoot)
    const branch = deleteBranch ? branchTip(w.repoRoot, w.branch) : null
    return branch !== null
      ? {
          removed: false,
          detail: `git could not remove branch ${w.branch}; it remains at ${branch}`,
        }
      : { removed: true, detail: `${w.path} was already gone` }
  }
  // REPORTED, not swallowed. This function's own comment says a removal that
  // silently fails leaves the run's changes on disk with nothing pointing at
  // them — and then it discarded git's answer, after which `orch discard`
  // cleared the database pointer and said "discarded". A locked or busy
  // worktree produced exactly the orphan the comment warned about, announced
  // as a success.
  const gone = gitOk(['worktree', 'remove', '--force', w.path], w.repoRoot) !== null
  if (deleteBranch) gitOk(['branch', '-D', w.branch], w.repoRoot)
  const branch = deleteBranch ? branchTip(w.repoRoot, w.branch) : null
  return (gone || !existsSync(w.path)) && (!deleteBranch || branch === null)
    ? { removed: true, detail: w.path }
    : branch !== null
      ? {
          removed: false,
          detail: `git could not remove branch ${w.branch}; it remains at ${branch}`,
        }
      : { removed: false, detail: `git could not remove ${w.path}; it is still on disk` }
}

/** Delete a local branch when it exists, reporting whether there was work to do. */
export function removeBranch(repoRoot: string, branch: string): boolean {
  if (gitOk(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot) === null) {
    return false
  }
  git(['branch', '-D', branch], repoRoot)
  return true
}

/** Read a local branch tip so cleanup can restore a ref another run still records. */
export function branchTip(repoRoot: string, branch: string): string | null {
  return gitOk(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot)
}

export type UnmergedBranch = { count: number; tip: string }

/**
 * Commits reachable only from this local branch — deleting it would lose them.
 *
 * Counted against every other branch, remote, and tag. Callers may additionally
 * exclude the recorded cut when they need the human-facing count of commits
 * made after that cut, but branch retention always uses the null-base form:
 * deleting the ref must not lose its cut commit after another ref is rewound.
 */
export function unmergedBranch(
  repoRoot: string,
  branch: string,
  baseCommit: string | null,
): UnmergedBranch | null {
  const ref = `refs/heads/${branch}`
  if (gitOk(['show-ref', '--verify', '--quiet', ref], repoRoot) === null) return null
  const tip = git(['rev-parse', ref], repoRoot)
  const args = ['rev-list', '--count', branch]
  if (baseCommit) args.push(`^${baseCommit}`)
  args.push('--not', `--exclude=${branch}`, '--branches', '--remotes', '--tags')
  const count = Number(git(args, repoRoot))
  return count > 0 ? { count, tip } : null
}

/** Restore a protected branch, retaining git's refusal for an actionable cleanup report. */
export function restoreBranch(
  repoRoot: string,
  branch: string,
  tip: string,
): { ok: true } | { ok: false; error: string } {
  const ref = `refs/heads/${branch}`
  const existing = gitOk(['rev-parse', '--verify', ref], repoRoot)
  if (existing === tip) return { ok: true }
  if (existing !== null) {
    return { ok: false, error: `branch already exists at ${existing}` }
  }
  const zero = '0000000000000000000000000000000000000000'
  const p = Bun.spawnSync(['git', 'update-ref', ref, tip, zero], {
    cwd: repoRoot,
    env: targetGitEnvironment(repoRoot),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return p.exitCode === 0
    ? { ok: true }
    : { ok: false, error: p.stderr.toString().trim() || `exit ${p.exitCode}` }
}
