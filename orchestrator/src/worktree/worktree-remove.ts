// concern: worktree-remove
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  assertBranchRefDecisionMayBeDeleted,
  observeBranchRef,
  observeBranchRefMutation,
} from '../branch/branch-ref-guard.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import {
  borrowedCheckoutOf,
  git,
  gitOk,
  gitRaw,
  withTemporaryGitIndex,
} from '../git/git-environment.ts'
import {
  absentTreeTeardownPlan,
  projectAt,
  resolvedWorktreeTool,
  type WorktreeTool,
} from '../project/projects.ts'
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
import { removalWorkingDirectoryRefusal } from './removal-working-directory.ts'
import { snapshotlessTrackedRecipeRefusal } from './snapshotless-tracked-recipe.ts'
import { extractWorktree, ORCH_RUN_MARKER } from './worktree-attribution.ts'
import { runShellTool } from './worktree-tool.ts'
import type { Worktree } from './worktree-types.ts'

export type WorktreeRemovalResult = {
  removed: boolean
  detail: string
  output?: string
  resourceTeardownCompleted?: true
  resourceTeardownFailed?: true
}

function portFor(runId: string): number {
  const row = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(runId)
  if (!row) throw new Error(`no run ${runId} for legacy recipe port derivation`)
  return 21000 + (row.number % 4000)
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
  runId: string,
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
  writeTransaction(() => {
    if (recipe.database && recipe.database.kind !== 'none') {
      const provider = recipe.database.kind
      const databaseDropped = databaseDroppedByTeardown(provider, teardown)
      settleDatabaseClaim(db(), {
        allocationKey: `${provider}:${dbName}`,
        databaseDropped,
        settledAt: nowIso(),
        detail: databaseDropped
          ? `${provider} teardown released ${dbName}`
          : `${provider} teardown failed; ${dbName} retained`,
      })
    }
    if (!firstFailure) setRecordedResourceTeardownDone(runId)
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
  return changesInIndex(
    w,
    sinceBase,
    undefined,
    (args) => git(args, w.path),
    (args) => gitOk(args, w.path),
    (args) => gitRaw(args, w.path),
  )
}

export function changesInIndex(
  w: Worktree,
  sinceBase: boolean,
  lowerBound: string | undefined,
  run: (args: string[]) => string,
  runOk: (args: string[]) => string | null,
  runRaw: (args: string[]) => string,
): Changes {
  run(['add', '-A'])
  const configuredTrunk = projectAt(w.repoRoot)?.settings.trunk?.trim()
  const trunk = configuredTrunk || 'main'
  const mergeBase = lowerBound ?? (sinceBase ? w.base : runOk(['merge-base', 'HEAD', trunk]))
  if (!mergeBase && configuredTrunk) {
    throw new Error(`cannot find merge-base between the run tip and trunk ${trunk}`)
  }
  // Never compare below the run's recorded base. A tree cut from the landing
  // branch's upstream while the local trunk branch still points at the caller's
  // HEAD has a merge-base with trunk strictly below the base it was cut from,
  // so diffing there would attribute the remote's already-landed commits to
  // this run. A merge-base at or above the recorded base is one the run's own
  // base is already an ancestor of, and is the truthful lower bound.
  const mergeBaseBelowBase =
    mergeBase !== null &&
    w.base !== '' &&
    runOk(['merge-base', '--is-ancestor', w.base, mergeBase]) === null
  // Unregistered scratch repositories predate the register and do not all call
  // their initial branch `main`. Their only truthful fallback is the recorded
  // base; registered projects must resolve their declared trunk above.
  const since = mergeBaseBelowBase ? w.base : (mergeBase ?? w.base)
  // Raw: this is a patch, and `git apply` counts its bytes.
  const diff = runRaw(['diff', '--cached', since])
  const names = runOk(['diff', '--cached', '--name-only', since]) ?? ''
  const stat = runOk(['diff', '--cached', '--numstat', since]) ?? ''

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

/** Read the complete visible change without changing the worktree's real index. */
export function observedChangesIn(w: Worktree, sinceBase = false, lowerBound?: string): Changes {
  return withTemporaryGitIndex(w.path, ({ git, gitOk, gitRaw }) =>
    changesInIndex(w, sinceBase, lowerBound, git, gitOk, gitRaw),
  )
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
 * `bottega run discard` is a decision someone makes.
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
  runId?: string,
  classifiedTip: string | null = branchTip(w.repoRoot, w.branch),
  removeTree: () => { removed: boolean; detail: string } = () =>
    removeWorktree(w, keepBranch, classifiedTip),
): WorktreeRemovalResult {
  const name = w.path.split('/').pop() ?? w.path
  const branchBefore = classifiedTip
  const uniqueBefore = unmergedBranch(w.repoRoot, w.branch, null)

  // A recipe-built tree is torn down the same way it was made: bottega
  // provisioned the database, so bottega drops it. Done BEFORE the directory
  // goes, because a compose file that lives in the worktree cannot bring
  // anything down once the worktree has been deleted.
  if (!tool.remove) {
    return removeWithoutCommand(tool, w, keepBranch, classifiedTip, runId)
  }

  const vars: Record<string, string> = { name, path: w.path }
  if (w.branch) vars.branch = w.branch
  const branchRefusal = toolBranchDeletionRefusal(w, keepBranch, classifiedTip)
  if (branchRefusal) return { removed: false, detail: branchRefusal }
  const r = runShellTool(tool.remove, vars, w.repoRoot)
  if (r.ok && !existsSync(w.path)) {
    markRecordedResourceTeardownDone(runId)
    const branchAfter = branchTip(w.repoRoot, w.branch)
    const mutationFailure = projectToolBranchMutationFailure({
      worktree: w,
      keepBranch,
      branchBefore,
      branchAfter,
      uniqueBefore,
      output: r.out,
    })
    if (mutationFailure) return mutationFailure
    const reconciled = removeTree()
    return {
      ...reconciled,
      ...(r.out ? { output: r.out } : {}),
      resourceTeardownCompleted: true,
    }
  }

  // The marker is the proof that orchestrator made and owns this disposable checkout.
  // A project's removal guard can therefore be forced only when the operator
  // explicitly asked and this exact proof is still present. Names and branch
  // templates also recognize old trees for sweep, but are deliberately not
  // strong enough evidence for destructive fallback here.
  if (forceOrchTree && existsSync(join(w.path, ORCH_RUN_MARKER))) {
    return removeWorktree(w, keepBranch, classifiedTip)
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
    resourceTeardownFailed: true,
    detail:
      `${w.path} was NOT removed — the project's own tool refused, and orchestrator will not ` +
      `force past that:\n${r.out.slice(-600) || `exit code from ${tool.remove}`}\n\n` +
      `Those refusals guard uncommitted work and unmerged branches. Inspect and resolve ` +
      `the protected work with the project's own tooling, then run ${PLATFORM_SLUG} run discard again. ` +
      `--force will not override a project tool's refusal unless the tree carries orchestrator's ` +
      `${ORCH_RUN_MARKER} ownership marker.`,
  }
}

function projectToolBranchMutationFailure(input: {
  worktree: Worktree
  keepBranch: boolean
  branchBefore: string | null
  branchAfter: string | null
  uniqueBefore: UnmergedBranch | null
  output: string
}): WorktreeRemovalResult | null {
  if (
    input.branchAfter === null ||
    input.branchAfter === input.branchBefore ||
    (input.uniqueBefore === null && input.keepBranch)
  ) {
    return null
  }
  const detail =
    input.branchBefore === null
      ? `project remove tool created unprotected branch ${input.worktree.branch} at ${input.branchAfter}; it was left in place`
      : input.uniqueBefore
        ? `project remove tool moved unique branch ${input.worktree.branch} from ${input.branchBefore} to ${input.branchAfter}; it was left in place`
        : `project remove tool moved unprotected branch ${input.worktree.branch} from ${input.branchBefore} to ${input.branchAfter}; it was left in place`
  return {
    removed: false,
    detail,
    ...(input.output ? { output: input.output } : {}),
  }
}

function toolBranchDeletionRefusal(
  worktree: Worktree,
  keepBranch: boolean,
  classifiedTip: string | null,
): string | null {
  if (!worktree.branch || keepBranch) return null
  try {
    const observation = observeBranchRefMutation(worktree.repoRoot, 'delete', worktree.branch)
    if (!observation.decision.allowed && observation.decision.reason === 'case-collision') {
      assertBranchRefDecisionMayBeDeleted(observation.decision, worktree.branch)
    }
    if (observation.exactTip !== classifiedTip) {
      throw new Error(
        `refusing to delete branch ${worktree.branch}: branch moved since it was classified (${classifiedTip ?? 'absent'} to ${observation.exactTip ?? 'absent'})`,
      )
    }
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function removeWithoutCommand(
  tool: WorktreeTool,
  w: Worktree,
  keepBranch: boolean,
  classifiedTip: string | null,
  runId?: string,
): WorktreeRemovalResult {
  const snapshotRefusal = snapshotlessTrackedRecipeRefusal({
    hasRunRow: runId !== undefined,
    trackedRecipe: Boolean(tool.recipePath),
    treePath: w.path,
    mainCheckoutPath: w.repoRoot,
  })
  if (snapshotRefusal) return { removed: false, detail: snapshotRefusal }
  if (tool.recipePath) {
    let teardownCompleted = false
    const removed = teardownTrackedRecipe({
      runId: runId!,
      worktree: w,
      remove: () => {
        teardownCompleted = true
        return removeWorktree(w, keepBranch, classifiedTip)
      },
    })
    return teardownCompleted
      ? { ...removed, resourceTeardownCompleted: true }
      : { ...removed, resourceTeardownFailed: true }
  }
  if (!tool.recipe || runId === undefined) return removeWorktree(w, keepBranch, classifiedTip)
  const teardown = teardownBuiltInRecipe(tool.recipe, w, runId)
  return teardown.ok
    ? { ...removeWorktree(w, keepBranch, classifiedTip), resourceTeardownCompleted: true }
    : {
        removed: false,
        detail: `recipe teardown failed at "${teardown.step}": ${teardown.detail.slice(-200)}`,
        resourceTeardownFailed: true,
      }
}

export function removeReadOnlyTree(
  tool: WorktreeTool,
  w: Worktree,
  _keepBranch = false,
): { removed: boolean; detail: string; output?: string } {
  if (!tool.readonly_remove) return removeReadOnlyDirectory(w)
  const result = runShellTool(tool.readonly_remove, { path: w.path }, w.repoRoot)
  if (!result.ok) {
    return {
      removed: false,
      detail:
        `${w.path} was NOT removed — the project's read-only remove tool refused:\n` +
        `${result.out.slice(-600) || `exit code from ${tool.readonly_remove}`}`,
    }
  }
  const reconciled = removeReadOnlyDirectory(w)
  return result.out ? { ...reconciled, output: result.out } : reconciled
}

export type ReadOnlyRemovalSafetyInput = {
  path: string
  repoRoot: string
  gitEntryExists: boolean
  borrowedSource: string | null
}

/** Decide whether a resolved path can be deleted as this project's disposable reader clone. */
export function readOnlyRemovalRefusal(input: ReadOnlyRemovalSafetyInput): string | null {
  const pathToRepo = relative(input.path, input.repoRoot)
  if (pathToRepo === '' || (!pathToRepo.startsWith('..') && !isAbsolute(pathToRepo))) {
    return (
      `refusing to remove ${input.path}: it is the main checkout or an ancestor of ` +
      `${input.repoRoot}; correct the run's worktree path, then retry cleanup`
    )
  }
  if (input.gitEntryExists && input.borrowedSource !== input.repoRoot) {
    return (
      `refusing to remove ${input.path}: its .git does not identify a reader clone borrowing ` +
      `from ${input.repoRoot}; inspect the checkout and correct the run's worktree path, then retry cleanup`
    )
  }
  const readersRoot = join(input.repoRoot, '.claude', 'worktrees')
  const fromReadersRoot = relative(readersRoot, input.path)
  if (
    !input.gitEntryExists &&
    (fromReadersRoot === '' || fromReadersRoot.startsWith('..') || isAbsolute(fromReadersRoot))
  ) {
    return (
      `refusing to remove ${input.path}: it has no .git and is outside ${readersRoot}; ` +
      `move or correct the partial reader path under that directory, then retry cleanup`
    )
  }
  return null
}

/** A reader is an independent clone, never a main-repository worktree record. */
export function removeReadOnlyDirectory(w: Worktree): { removed: boolean; detail: string } {
  if (!existsSync(w.path)) return { removed: true, detail: `${w.path} was already gone` }
  let path: string
  let repoRoot: string
  let gitEntryExists: boolean
  let borrowedSource: string | null = null
  try {
    path = realpathSync(w.path)
    repoRoot = realpathSync(w.repoRoot)
    gitEntryExists = existsSync(join(path, '.git'))
    if (gitEntryExists) {
      const borrowed = borrowedCheckoutOf(path)
      borrowedSource = borrowed ? realpathSync(borrowed) : null
    }
  } catch (error) {
    return {
      removed: false,
      detail:
        `could not establish that ${w.path} is a reader clone of ${w.repoRoot}: ${String(error)}; ` +
        `inspect both paths and correct the run row, then retry cleanup`,
    }
  }
  const refusal = readOnlyRemovalRefusal({ path, repoRoot, gitEntryExists, borrowedSource })
  if (refusal) return { removed: false, detail: refusal }
  try {
    rmSync(w.path, { recursive: true, force: true })
  } catch (error) {
    return { removed: false, detail: `could not remove ${w.path}: ${String(error)}` }
  }
  return existsSync(w.path)
    ? { removed: false, detail: `could not remove ${w.path}; it is still on disk` }
    : { removed: true, detail: w.path }
}

function mintedBranchOwnedBy(w: Worktree, runId?: string): string | null {
  if (runId !== undefined) {
    try {
      const row = db().query('SELECT minted_branch FROM run WHERE record_id=?').get(runId) as {
        minted_branch: string | null
      } | null
      if (row) return row.minted_branch
    } catch {
      /* a store mid-migrate has no minted_branch yet */
    }
  }
  return w.mintedBranch ?? null
}

function setRecordedResourceTeardownDone(runId: string): void {
  db()
    .query(
      `UPDATE run SET resource_teardown='done'
       WHERE record_id=(SELECT COALESCE(parent_run_record_id,record_id) FROM run WHERE record_id=?)
         AND resource_teardown='pending'`,
    )
    .run(runId)
}

function markRecordedResourceTeardownDone(runId: string | undefined): void {
  if (runId === undefined) return
  writeTransaction(() => setRecordedResourceTeardownDone(runId))
}

function recordedTeardownFacts(runId: string | undefined): {
  recipeSnapshot: string | null
  worktreeSource: Worktree['source'] | null
  resourceTeardown: 'pending' | 'done' | null
} {
  if (runId === undefined)
    return { recipeSnapshot: null, worktreeSource: null, resourceTeardown: null }
  const row = db()
    .query(
      `SELECT recipe_snapshot,worktree_source,resource_teardown FROM run
       WHERE record_id=(SELECT COALESCE(parent_run_record_id,record_id) FROM run WHERE record_id=?)`,
    )
    .get(runId) as {
    recipe_snapshot: string | null
    worktree_source: Worktree['source'] | null
    resource_teardown: 'pending' | 'done' | null
  } | null
  return {
    recipeSnapshot: row?.recipe_snapshot ?? null,
    worktreeSource: row?.worktree_source ?? null,
    resourceTeardown: row?.resource_teardown ?? null,
  }
}

/** Whether an absent tree still has a recorded lifecycle capable of releasing its resources. */
export function hasAbsentTreeTeardownPlan(repoRoot: string, runId: string): boolean {
  const facts = recordedTeardownFacts(runId)
  return absentTreeTeardownPlan({
    ...facts,
    registeredRemoveCommand: Boolean(resolvedWorktreeTool(projectAt(repoRoot))?.remove),
  })
}

function absentLifecycleRemoval(input: {
  worktree: Worktree
  runId?: string
  removeTree(): { removed: boolean; detail: string }
}): WorktreeRemovalResult | null {
  if (existsSync(input.worktree.path)) return null
  const facts = recordedTeardownFacts(input.runId)
  if (facts.resourceTeardown !== 'pending') return input.removeTree()
  if (!facts.recipeSnapshot) return null
  let teardownCompleted = false
  const removed = teardownTrackedRecipe({
    runId: input.runId!,
    worktree: input.worktree,
    remove: () => {
      teardownCompleted = true
      return input.removeTree()
    },
    treeExists: false,
  })
  return teardownCompleted
    ? { ...removed, resourceTeardownCompleted: true }
    : { ...removed, resourceTeardownFailed: true }
}

function removeByLifecycle(input: {
  worktree: Worktree
  tool: WorktreeTool | null
  projectName: string | null
  forceOrchTree: boolean
  retainBranch: boolean
  classifiedTip: string | null
  runId?: string
  removeTree(): { removed: boolean; detail: string }
}): WorktreeRemovalResult {
  const { worktree, tool, runId, removeTree } = input
  if (recordedTeardownFacts(runId).resourceTeardown === 'done') return removeTree()
  const absentRemoval = absentLifecycleRemoval({ worktree, runId, removeTree })
  if (absentRemoval) return absentRemoval
  if (worktree.source === 'readonly_recipe' || worktree.source === 'clone') {
    const removed: { removed: boolean; detail: string; output?: string } = removeReadOnlyTree(
      tool ?? {},
      worktree,
      input.retainBranch,
    )
    return removed.output && input.projectName
      ? { ...removed, output: `${input.projectName} readonly remove:\n${removed.output}` }
      : removed
  }
  const projectOwned =
    worktree.source === 'recipe' || (worktree.source === undefined && Boolean(tool))
  const removed: WorktreeRemovalResult =
    tool && projectOwned
      ? removeWithTool(
          tool,
          worktree,
          input.forceOrchTree,
          input.retainBranch,
          runId,
          input.classifiedTip,
          removeTree,
        )
      : removeWorktree(worktree, input.retainBranch, input.classifiedTip)
  return removed.output && input.projectName
    ? { ...removed, output: `${input.projectName} remove:\n${removed.output}` }
    : removed
}

/** Remove a tree through the lifecycle declared by its registered project. */
export function removeFor(
  w: Worktree,
  repoRoot: string,
  forceOrchTree = false,
  keepBranch = false,
  runId?: string,
  forceUnmerged = false,
  skipGitRemoval = false,
  scratchAlreadyArchived = false,
): WorktreeRemovalResult {
  const cwdRefusal = removalWorkingDirectoryRefusal(w.path, repoRoot)
  if (cwdRefusal) return { removed: false, detail: cwdRefusal }
  // The marker identifies who created a tree; it does not transfer that run's
  // branch ownership to a later attacher. Cleanup names only the discarding
  // run's minted branch.
  const owningRunId = runId ?? markedWorktreeRunId(w.path)
  if (existsSync(w.path) && !scratchAlreadyArchived) {
    const extracted = extractWorktree(w.path, owningRunId)
    if (!extracted.ok) return { removed: false, detail: extracted.detail }
  }
  const minted = mintedBranchOwnedBy(w, runId)
  // Unminted: the git branch is not ours to name to a project tool. Pass the
  // tree only. Minted: the tool receives that branch name, never ''.
  const owned = { ...w, branch: minted ?? '' }
  const project = projectAt(repoRoot)
  const tool = resolvedWorktreeTool(project)
  const classification = minted ? classifyBranch(repoRoot, minted, null) : null
  const retainBranch =
    keepBranch || !minted || (!forceUnmerged && Boolean(classification?.unmerged))
  const removeTree = () =>
    skipGitRemoval
      ? { removed: true, detail: `${w.path} was already gone` }
      : removeWorktree(owned, retainBranch, classification?.tip ?? null)
  const result = removeByLifecycle({
    worktree: owned,
    tool,
    projectName: project?.name ?? null,
    forceOrchTree,
    retainBranch,
    classifiedTip: classification?.tip ?? null,
    runId,
    removeTree,
  })
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
  classifiedTip: string | null,
): { removed: boolean; detail: string } {
  const deleteBranch = Boolean(w.branch) && !keepBranch
  // Never prune the repository; remove only this worktree's own record.
  // Already gone is a SUCCESS, not an error. A worktree deleted by hand, or one
  // in a scratch repository that has since been cleaned up, leaves a database
  // pointer that ought to be clearable — refusing would strand it for ever.
  if (!existsSync(w.path)) {
    gitOk(['worktree', 'remove', '--force', w.path], w.repoRoot)
    return (
      removeOwnedWorktreeBranch(w, deleteBranch, classifiedTip) ?? {
        removed: true,
        detail: `${w.path} was already gone`,
      }
    )
  }
  const cwdRefusal = removalWorkingDirectoryRefusal(w.path, w.repoRoot)
  if (cwdRefusal) return { removed: false, detail: cwdRefusal }
  // REPORTED, not swallowed. This function's own comment says a removal that
  // silently fails leaves the run's changes on disk with nothing pointing at
  // them — and then it discarded git's answer, after which `bottega run discard`
  // cleared the database pointer and said "discarded". A locked or busy
  // worktree produced exactly the orphan the comment warned about, announced
  // as a success.
  const gone = gitOk(['worktree', 'remove', '--force', w.path], w.repoRoot) !== null
  if (!gone) {
    return {
      removed: false,
      detail: existsSync(w.path)
        ? `git could not remove ${w.path}; it is still on disk`
        : `git could not remove the registered worktree ${w.path}`,
    }
  }
  const branchFailure = removeOwnedWorktreeBranch(w, deleteBranch, classifiedTip)
  if (branchFailure) return branchFailure
  return gone || !existsSync(w.path)
    ? { removed: true, detail: w.path }
    : { removed: false, detail: `git could not remove ${w.path}; it is still on disk` }
}

function removeOwnedWorktreeBranch(
  worktree: Worktree,
  deleteBranch: boolean,
  classifiedTip: string | null,
): WorktreeRemovalResult | null {
  if (!deleteBranch) return null
  try {
    removeBranch(worktree.repoRoot, worktree.branch, classifiedTip)
  } catch (error) {
    return { removed: false, detail: error instanceof Error ? error.message : String(error) }
  }
  const branch = branchTip(worktree.repoRoot, worktree.branch)
  return branch === null
    ? null
    : {
        removed: false,
        detail: `git could not remove branch ${worktree.branch}; it remains at ${branch}`,
      }
}

/** Delete a local branch when it exists, reporting whether there was work to do. */
export function removeBranch(
  repoRoot: string,
  branch: string,
  classifiedTip: string | null,
): boolean {
  const observation = observeBranchRefMutation(repoRoot, 'delete', branch)
  const { decision } = observation
  if (!decision.allowed && decision.reason === 'exact-missing') return false
  assertBranchRefDecisionMayBeDeleted(decision, branch)
  const tip = observation.exactTip
  if (!tip) throw new Error(`refusing to delete branch ${branch}: its exact tip could not be read`)
  if (tip !== classifiedTip) {
    throw new Error(
      `refusing to delete branch ${branch}: branch moved since it was classified (${classifiedTip} to ${tip})`,
    )
  }
  const checkedOutAt = checkedOutBranchPath(
    git(['worktree', 'list', '--porcelain'], repoRoot),
    branch,
  )
  if (checkedOutAt) {
    throw new Error(`refusing to delete branch ${branch}: branch is checked out in ${checkedOutAt}`)
  }
  // branch-ref-guard: observeBranchRefMutation
  git(['update-ref', '-d', `refs/heads/${branch}`, tip], repoRoot)
  return true
}

/** Return the registered worktree path where an exact local branch is checked out. */
export function checkedOutBranchPath(porcelain: string, branch: string): string | null {
  let path: string | null = null
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    if (line === `branch refs/heads/${branch}`) return path
    if (line === '') path = null
  }
  return null
}

/** Read a local branch tip so cleanup can restore a ref another run still records. */
export function branchTip(repoRoot: string, branch: string): string | null {
  try {
    return observeBranchRef(repoRoot, branch).exactTip
  } catch {
    return null
  }
}

export type UnmergedBranch = { count: number; tip: string }
type BranchClassification = { tip: string; unmerged: UnmergedBranch | null }

function classifyBranch(
  repoRoot: string,
  branch: string,
  baseCommit: string | null,
): BranchClassification | null {
  const tip = branchTip(repoRoot, branch)
  if (tip === null) return null
  const args = ['rev-list', '--count', tip]
  if (baseCommit) args.push(`^${baseCommit}`)
  args.push('--not', `--exclude=${branch}`, '--branches', '--remotes', '--tags')
  const count = Number(git(args, repoRoot))
  return { tip, unmerged: count > 0 ? { count, tip } : null }
}

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
  return classifyBranch(repoRoot, branch, baseCommit)?.unmerged ?? null
}
