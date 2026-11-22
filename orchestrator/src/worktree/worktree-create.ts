// concern: worktree-create
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { assertBranchRefMayBeCreated } from '../branch/branch-ref-guard.ts'
import { settleCreateTimeBranchCleanup } from '../branch/create-time-settlement.ts'
import { db } from '../database/db.ts'
import { git, gitOk, repoRootOf, targetGitEnvironment } from '../git/git-environment.ts'
import { withWorktreeCreateLock } from '../project/project-lock.ts'
import { projectAt, type WorktreeTool } from '../project/projects.ts'
import { dbNameFor, type Recipe, type RecipeDatabaseProvider, runRecipe } from '../recipe/recipe.ts'
import { createTrackedRecipe } from '../recipe/tracked-recipe.ts'
import { ORCH_RUN_MARKER } from './worktree-attribution.ts'
import { resolveBase } from './worktree-caller.ts'
import { branchTip, removeFor, removeWorktree } from './worktree-remove.ts'
import { projectSeedPreflight } from './worktree-seed.ts'
import { createArgv, fillArg, fillTool, type WorktreeCreate } from './worktree-template.ts'
import type { Worktree } from './worktree-types.ts'

export type RecordWorktree = (worktree: Worktree) => void
export type RecordRecipeResource = (resource: {
  kind: 'database'
  provider: RecipeDatabaseProvider
  name: string
}) => void
export type ClaimRecipePort = () => number
const LIVE_WORKTREE_OWNER_SQL =
  "SELECT record_id,number FROM run WHERE worktree = ? AND status IN ('running','asking') LIMIT 1"

export function worktreeCreateVariables(
  branchTemplate: string | undefined,
  existingBranch: string | undefined,
  runId: string,
  key: string | undefined,
  seed: string | undefined,
  base: string,
) {
  const branch =
    existingBranch ??
    (branchTemplate ?? 'orch/{id}').replace(/\{id\}/g, String(runId)).replace(/\{key\}/g, key ?? '')
  return {
    branch,
    name: `orch-${runId}`,
    base,
    seed: seed ?? '',
    key: key ?? '',
    path: '',
  }
}

export function leftoverRemedy(
  removeTemplate: string | undefined,
  vars: Record<string, string>,
  path: string,
  existingBranch?: string,
  observedBranch?: string | null,
): string {
  if (existingBranch) {
    const branchState = continuedTreeBranchState(observedBranch)
    const remove = continuedTreeRemoveCommand(removeTemplate, vars, path, observedBranch)
    return (
      `\nThe tree was meant to sit on the existing branch ${existingBranch}, which holds the task's work and must be kept.\n` +
      `${branchState}\n` +
      (remove
        ? `Remove the tree and its provisioned resources after inspection:\n  ${remove}`
        : 'No remove command was filled because its {branch} value is not safe to infer.')
    )
  }
  const remove = removeTemplate
    ? fillTool(removeTemplate, { ...vars, path })
    : '(project declares no remove command)'
  return (
    `\nThe project created branch ${vars.branch} and may have provisioned resources.\n` +
    `Remove them when you have inspected the tree:\n  ${remove}`
  )
}

function continuedTreeBranchState(observedBranch: string | null | undefined): string {
  if (observedBranch === null) return 'The tree is detached and must be inspected first.'
  if (observedBranch) return `The project left the tree on branch ${observedBranch}.`
  return 'The branch currently checked out in the tree has not been established; inspect it before removal.'
}

function continuedTreeRemoveCommand(
  removeTemplate: string | undefined,
  vars: Record<string, string>,
  path: string,
  observedBranch: string | null | undefined,
): string | null {
  if (!removeTemplate) return '(project declares no remove command)'
  if (!observedBranch && removeTemplate.includes('{branch}')) return null
  return fillTool(removeTemplate, {
    ...vars,
    ...(observedBranch ? { branch: observedBranch } : {}),
    path,
  })
}

export function commandCreatedBranchMatches(
  existingBranch: string | undefined,
  detached: boolean,
  symbolicHead: string | null,
): boolean {
  return !existingBranch || detached || symbolicHead === `refs/heads/${existingBranch}`
}

function assertCommandCreatedCheckout(
  detached: boolean,
  existingBranch: string | undefined,
  path: string,
  base: string,
  projectName: string,
  leftover: (path: string, observedBranch?: string | null) => string,
): void {
  if (detached) {
    const symbolicHead = gitOk(['symbolic-ref', '-q', 'HEAD'], path)
    const head = gitOk(['rev-parse', 'HEAD'], path)
    if (symbolicHead !== null || head !== base) {
      throw new Error(
        `project ${projectName}: worktree.create detached review ` +
          `postcondition failed; expected detached HEAD at ${base}, got ` +
          `${symbolicHead ?? '(detached HEAD)'} at ${head ?? '(unresolved)'}.` +
          leftover(path),
      )
    }
    return
  }
  if (!existingBranch) return
  const symbolicHead = gitOk(['symbolic-ref', '-q', 'HEAD'], path)
  const expected = `refs/heads/${existingBranch}`
  if (!commandCreatedBranchMatches(existingBranch, detached, symbolicHead)) {
    const observedBranch = symbolicHead?.startsWith('refs/heads/')
      ? symbolicHead.slice('refs/heads/'.length)
      : null
    throw new Error(
      `project ${projectName}: worktree.create existing branch ` +
        `postcondition failed; expected ${expected}, got ${symbolicHead ?? '(detached HEAD)'}.` +
        leftover(path, observedBranch),
    )
  }
}

function runRecordedRecipe(
  worktree: Worktree,
  recipe: Recipe,
  runId: string,
  recordRecipeResource?: RecordRecipeResource,
  claimRecipePort?: ClaimRecipePort,
): ReturnType<typeof runRecipe> {
  const dbName = dbNameFor(worktree.repoRoot.split('/').pop() ?? 'app', runId)
  let recipeStarted = false
  try {
    const servePort = recipe.serve
      ? (
          claimRecipePort ??
          (() => {
            throw new Error('recipe serve requires a claimed port')
          })
        )()
      : null
    recipeStarted = true
    return runRecipe(recipe, worktree.path, dbName, String(servePort ?? ''), (provider, name) =>
      recordRecipeResource?.({ kind: 'database', provider, name }),
    )
  } catch (error) {
    const cleanup = recipeStarted
      ? removeFor(worktree, worktree.repoRoot, false, false, runId)
      : removeWorktree(worktree, false, branchTip(worktree.repoRoot, worktree.branch))
    settleCreateTimeBranchCleanup(worktree, runId)
    throw new Error(
      `${String((error as Error)?.message ?? error)}\n` +
        `unrecorded recipe resource cleanup: ${cleanup.removed ? 'removed' : cleanup.detail}`,
    )
  }
}

/** Mark a tree as orch-owned without asking the project to track orchestrator metadata. */
function markWorktree(
  path: string,
  runId: string,
  repoRoot: string,
  source: NonNullable<Worktree['source']>,
): void {
  const owner = db()
    .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
    .get(runId)
  if (!owner) throw new Error(`cannot mark worktree: no run ${runId}`)
  writeFileSync(join(path, ORCH_RUN_MARKER), `${owner.record_id}\n${repoRoot}\nsource: ${source}\n`)
  const exclude = resolve(path, git(['rev-parse', '--git-path', 'info/exclude'], path))
  const existing = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  if (!existing.split('\n').includes(ORCH_RUN_MARKER)) {
    appendFileSync(
      exclude,
      `${existing && !existing.endsWith('\n') ? '\n' : ''}${ORCH_RUN_MARKER}\n`,
    )
  }
}

/**
 * Give a newly-created directory an owner before any later setup can fail.
 *
 * The database pointer deliberately comes before the marker. If recording
 * succeeds and marking fails, the run still names the directory and explicit
 * cleanup can reclaim it. The reverse order recreates the orphan this boundary
 * exists to prevent. A failed record tears the new tree down immediately.
 */
export function attributeWorktree(
  worktree: Worktree,
  runId: string,
  record?: RecordWorktree,
): void {
  try {
    record?.(worktree)
  } catch (e) {
    const cleanup = removeFor(worktree, worktree.repoRoot, false, false, runId)
    throw new Error(
      `${String((e as Error)?.message ?? e)}\n` +
        `unrecorded worktree cleanup: ${cleanup.removed ? 'removed' : cleanup.detail}`,
    )
  }
  const recorded = db().query('SELECT status FROM run WHERE record_id=?').get(runId) as {
    status: string
  } | null
  if (recorded?.status === 'stopped') {
    const cleanup = removeFor(worktree, worktree.repoRoot, false, false, runId)
    settleCreateTimeBranchCleanup(worktree, runId)
    if (cleanup.removed) {
      db().query('UPDATE run SET worktree=NULL WHERE record_id=?').run(runId)
    }
    throw new Error(
      `run ${runId} stopped during worktree creation; ` +
        `cleanup: ${cleanup.removed ? 'removed' : cleanup.detail}`,
    )
  }
  if (!worktree.source) throw new Error(`worktree ${worktree.path} has no lifecycle source`)
  markWorktree(worktree.path, runId, worktree.repoRoot, worktree.source)
}

/**
 * Cut a worktree for one run.
 *
 * Named by run id, which makes the mapping between a row and a directory
 * total in both directions: no run owns two worktrees and no worktree is
 * orphaned from its row. A timestamp or a slug would read better and would not
 * survive two runs of the same job in the same minute.
 *
 * The caller's visible state is transferred after creation by
 * `carryWorkingState` only when the launch opted in; cutting the directory is
 * the first half of setup either way.
 */
/**
 * Fill and run a trusted shell declaration. Create reaches this only through
 * the registration-validated pipeline escape hatch; remove and sweep remain
 * lifecycle shell templates are outside the create-command pipeline.
 */

export function runCreateTool(
  create: WorktreeCreate | string,
  vars: Record<string, string>,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): { ok: boolean; out: string; stdout: string } {
  const argv = createArgv(create, vars)
  const declaredEnv =
    typeof create === 'object' && 'command' in create
      ? Object.fromEntries(
          Object.entries(create.env ?? {}).map(([name, value]) => [name, fillArg(value, vars)]),
        )
      : {}
  const p = Bun.spawnSync(argv, {
    cwd,
    env: { ...(env ?? process.env), ...declaredEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = p.stdout.toString()
  const out = `${stdout}${p.stderr.toString()}`.trim()
  return { ok: p.exitCode === 0, out, stdout }
}

/** Resolve a caller's base before any worktree or run row is created. */

export function createWithTool(
  tool: WorktreeTool,
  cwd: string,
  runId: string,
  seed?: string,
  key?: string,
  baseRef?: string,
  record?: RecordWorktree,
  detached = false,
  existingBranch?: string,
  recordRecipeResource?: RecordRecipeResource,
  claimRecipePort?: ClaimRecipePort,
  requestedBranch?: string,
  templateBaseRef?: string,
): Worktree {
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)
  const project = projectAt(cwd) ?? projectAt(repoRoot)
  const projectName = project?.name ?? '(unregistered)'
  const seedDecision = projectSeedPreflight({
    requested: seed,
    writesRepo: true,
    project,
    tool,
    baseRef,
  })
  if (seedDecision.refusal) throw new Error(seedDecision.refusal)
  return withWorktreeCreateLock(repoRoot, () =>
    createWithToolUnlocked(
      tool,
      repoRoot,
      runId,
      seedDecision.seed,
      key,
      baseRef,
      record,
      detached,
      projectName,
      existingBranch,
      recordRecipeResource,
      claimRecipePort,
      requestedBranch,
      templateBaseRef,
    ),
  )
}

function createWithToolUnlocked(
  tool: WorktreeTool,
  repoRoot: string,
  runId: string,
  seed?: string,
  key?: string,
  baseRef?: string,
  record?: RecordWorktree,
  detached = false,
  projectName = '(unregistered)',
  existingBranch?: string,
  recordRecipeResource?: RecordRecipeResource,
  claimRecipePort?: ClaimRecipePort,
  requestedBranch?: string,
  templateBaseRef?: string,
): Worktree {
  // The project's own naming rule wins where it has one. `orch/<id>` is fine
  // where nothing enforces a convention and is refused outright where something
  // does — imposing our name on a repository whose tooling reads branch names
  // is the mistake delegating the lifecycle was meant to stop.
  /**
   * A RECIPE builds the tree here; a COMMAND hands it to the project's script.
   *
   * Both end with a fully provisioned worktree and differ only in who does the
   * provisioning. A project that already has a script keeps it — nothing here
   * is better than several hundred lines written against that project's actual
   * infrastructure. A project that has none declares what it needs and never
   * writes the script at all, which is the point.
   */
  if (!tool.create) {
    return createWithoutCommand(
      tool,
      repoRoot,
      runId,
      seed,
      key,
      baseRef,
      record,
      detached,
      existingBranch,
      recordRecipeResource,
      claimRecipePort,
      requestedBranch,
    )
  }
  // A base is a commit; the branch is cut there even without a {base} template slot.
  const base = baseRef ? resolveBase(repoRoot, baseRef) : git(['rev-parse', 'HEAD'], repoRoot)
  const vars = worktreeCreateVariables(
    tool.branch,
    existingBranch,
    runId,
    key,
    seed,
    templateBaseRef ?? base,
  )
  const { branch, name } = vars
  const r = runGuardedCreateTool(tool, vars, repoRoot, detached, existingBranch)
  if (!r.ok) throw new Error(`the project's worktree tool failed:\n${r.out.slice(-1500)}`)
  /**
   * A successful project tool may still fail orchestrator's postconditions. At that
   * point the tree, branch and database belong to the project's lifecycle and
   * are deliberately left intact: uncertainty is exactly when automatic
   * teardown has lost work. Every such error therefore carries the branch and
   * the project's ready-to-paste remove command.
   */
  const leftover = (path: string, observedBranch?: string | null) =>
    leftoverRemedy(tool.remove, vars, path, existingBranch, observedBranch)

  /**
   * WHERE IT PUT THE WORKTREE is read from the tool's LAST LINE, not hunted for.
   *
   * This used to take the last path-looking line that happened to exist
   * anywhere in the output, which is how a run in one application came back owning
   * `.claude/worktrees/STAR-5084` — a directory belonging to the session's own
   * task, matched out of progress output because the create template printed no
   * path of its own. Three runs then shared one tree and a fourth worked in it.
   *
   * So a project's `create` must END by printing its path, and that is the line
   * taken. A tool that logs progress sends it to stderr, which these templates
   * now do.
   *
   * The last line OF STDOUT, and that qualifier is the whole fix for run 735.
   * one project's tool did exactly what is asked: the path on stdout, progress on
   * stderr. This read the last line of stdout and stderr joined together,
   * with stderr second — so the line it saw was `✓ task status not written`,
   * not a path, and it fell back to `orch-735`, a directory nothing had made.
   * A tool that separates its streams properly must not lose to one that
   * does not; the streams are read apart.
   */
  const lastLine =
    r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ''
  /**
   * Prefer what the tool printed over anything we compute.
   *
   * A project that knows where it puts its worktrees should not be
   * second-guessed by a join against our idea of the layout. An absolute
   * last line is that path, even if it does not exist yet — the check
   * below then names the path the tool claimed, not a nested guess.
   * A relative last line is resolved against the MAIN checkout, and only
   * trusted if that directory is actually there, so a progress line is
   * not mistaken for a path.
   */
  const printed = lastLine ? join(repoRoot, lastLine) : ''
  const path = lastLine.startsWith('/')
    ? lastLine
    : printed && existsSync(printed)
      ? printed
      : join(repoRoot, '.claude', 'worktrees', name)
  if (!existsSync(path)) {
    throw new Error(
      `the project's worktree tool reported success but ${path} does not exist.\n` +
        `Its create command must print the worktree path as the last line of stdout.\n${r.out.slice(-800)}` +
        leftover(path),
    )
  }

  /**
   * EACH RUN GETS ITS OWN TREE. A shared one is refused, not tolerated.
   *
   * A project's script may name a directory from the ticket key rather than
   * from the run, so two runs carrying the same `--key` can be handed the same
   * directory — and the second would edit the first's work in place, with the
   * diffs of both interleaved beyond separating. The `discard` guard added
   * earlier stops orch DELETING a shared tree; this stops one being handed out
   * in the first place, which is the failure that matters.
   *
   * Read-only jobs never reach here: they get no worktree at all, and need
   * none.
   */
  const owner = db().query(LIVE_WORKTREE_OWNER_SQL).get(path) as {
    record_id: string
    number: number
  } | null
  if (owner) {
    throw new Error(
      `the project's worktree tool returned ${path}, which run ${owner.number} is still using.\n` +
        `Each run needs its own tree. Check that this project's branch template makes the\n` +
        `directory unique per run — a template keyed only on a ticket collides on the second.` +
        leftover(path),
    )
  }
  assertCommandCreatedCheckout(detached, existingBranch, path, base, projectName, leftover)
  // A command without {base} may deliberately choose its own floor. Read the
  // commit from the tree it actually created so the run record and every later
  // diff name that floor rather than the caller checkout's incidental HEAD.
  const actualBase = gitOk(['rev-parse', 'HEAD'], path) ?? base
  if (shouldCheckoutCreatedBranch(detached, existingBranch)) {
    checkoutCreatedBranch(repoRoot, path, branch, base, baseRef)
  }
  const worktree = {
    path,
    branch: detached ? '' : branch,
    base: gitOk(['rev-parse', 'HEAD'], path) ?? actualBase,
    repoRoot,
    source: 'recipe' as const,
    mintedBranch: detached || existingBranch ? null : branch,
  }
  try {
    attributeWorktree(worktree, runId, record)
    verifyFreshWorktree(worktree)
  } catch (e) {
    throw new Error(`${String((e as Error)?.message ?? e)}${leftover(path)}`)
  }
  return worktree
}

function checkoutCreatedBranch(
  repoRoot: string,
  path: string,
  branch: string,
  base: string,
  baseRef?: string,
): void {
  assertBranchRefMayBeCreated(repoRoot, branch)
  const dirty = gitOk(['status', '--porcelain=v1', '--untracked-files=no'], path)
  if (baseRef && !dirty) {
    // branch-ref-guard: assertBranchRefMayBeCreated
    git(['checkout', '-B', branch, base], path)
  } else {
    // branch-ref-guard: assertBranchRefMayBeCreated
    gitOk(['checkout', '-B', branch], path)
  }
}

function runGuardedCreateTool(
  tool: WorktreeTool,
  vars: ReturnType<typeof worktreeCreateVariables>,
  repoRoot: string,
  detached: boolean,
  existingBranch?: string,
): ReturnType<typeof runCreateTool> {
  if (shouldCheckoutCreatedBranch(detached, existingBranch)) {
    assertBranchRefMayBeCreated(repoRoot, vars.branch)
  }
  return runCreateTool(tool.create!, vars, repoRoot, targetGitEnvironment(repoRoot))
}

function shouldCheckoutCreatedBranch(detached: boolean, existingBranch?: string): boolean {
  return !detached && !existingBranch
}

function createWithoutCommand(
  tool: WorktreeTool,
  repoRoot: string,
  runId: string,
  seed?: string,
  key?: string,
  baseRef?: string,
  record?: RecordWorktree,
  detached = false,
  existingBranch?: string,
  recordRecipeResource?: RecordRecipeResource,
  claimRecipePort?: ClaimRecipePort,
  requestedBranch?: string,
): Worktree {
  if (tool.recipePath) {
    return createTrackedRecipe({
      tool,
      repoRoot,
      runId,
      seed,
      key,
      baseRef,
      detached,
      existingBranch,
      ...recipeWorktreeIdentity(tool, repoRoot, runId, key, existingBranch, requestedBranch),
      attribute: (worktree) => attributeWorktree(worktree, runId, record),
      verify: verifyFreshWorktree,
      remove: (worktree) =>
        removeWorktree(
          worktree,
          detached || Boolean(existingBranch),
          branchTip(worktree.repoRoot, worktree.branch),
        ),
      removeProvisioned: (worktree) => removeFor(worktree, repoRoot, false, false, runId),
    })
  }
  if (!tool.recipe) throw new Error(MISSING_WORKTREE_LIFECYCLE)
  return createFromRecipe(
    tool,
    tool.recipe,
    repoRoot,
    runId,
    key,
    baseRef,
    record,
    detached,
    existingBranch,
    recordRecipeResource,
    claimRecipePort,
  )
}

const MISSING_WORKTREE_LIFECYCLE =
  "this project's worktree settings declare neither `create`, `recipe` nor `recipePath`"

export function createWorktree(
  cwd: string,
  runId: string,
  baseRef?: string,
  record?: RecordWorktree,
  detached = false,
): Worktree {
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)
  return withWorktreeCreateLock(repoRoot, () =>
    createWorktreeUnlocked(repoRoot, runId, baseRef, record, detached),
  )
}

/** Cut a new disposable tree on a task branch that already exists. */
export function createWorktreeForBranch(
  cwd: string,
  runId: string,
  branch: string,
  record?: RecordWorktree,
): Worktree {
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)
  const base = resolveBase(repoRoot, branch)
  const path = join(repoRoot, '.claude', 'worktrees', `orch-${runId}`)
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path))
    throw new Error(`worktree ${path} already exists; run ${runId} would overwrite it`)
  git(['worktree', 'add', path, branch], repoRoot)
  const worktree: Worktree = {
    path,
    branch,
    base,
    repoRoot,
    source: 'git',
    mintedBranch: null,
  }
  attributeWorktree(worktree, runId, record)
  verifyFreshWorktree(worktree)
  return worktree
}

function createWorktreeUnlocked(
  repoRoot: string,
  runId: string,
  baseRef?: string,
  record?: RecordWorktree,
  detached = false,
): Worktree {
  const base = baseRef ? resolveBase(repoRoot, baseRef) : git(['rev-parse', 'HEAD'], repoRoot)
  const dir = join(repoRoot, '.claude', 'worktrees')
  mkdirSync(dir, { recursive: true })

  const branch = `orch/${runId}`
  const path = join(dir, `orch-${runId}`)
  if (existsSync(path)) {
    throw new Error(`worktree ${path} already exists; run ${runId} would overwrite it`)
  }
  if (!detached) assertBranchRefMayBeCreated(repoRoot, branch)
  // branch-ref-guard: assertBranchRefMayBeCreated
  git(['worktree', 'add', ...(detached ? ['--detach'] : ['-b', branch]), path, base], repoRoot)
  const worktree = {
    path,
    branch: detached ? '' : branch,
    base,
    repoRoot,
    source: 'git' as const,
    mintedBranch: detached ? null : branch,
  }
  attributeWorktree(worktree, runId, record)
  verifyFreshWorktree(worktree)
  return worktree
}

/** Cut the unprovisioned checkout used by a read-only repository job. */

export function verifyFreshWorktree(worktree: Worktree): void {
  const head = git(['rev-parse', 'HEAD'], worktree.path)
  if (head !== worktree.base) {
    throw new Error(
      `worktree verification failed: ${worktree.path} claims HEAD ${head}, ` +
        `but was created for ${worktree.base}`,
    )
  }

  // `status` compares HEAD, index and disk together and names non-ignored
  // untracked paths. A corrupt index is a hard git failure here, not an empty
  // answer, so the "unable to read <oid>" incident is made loud as well.
  let status: string
  try {
    status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktree.path)
  } catch (e) {
    throw new Error(
      `worktree verification failed: could not compare ${worktree.path} with HEAD ${head}: ` +
        String((e as Error)?.message ?? e),
    )
  }
  if (status) {
    const detail = status.split('\0').filter(Boolean).join('\n').slice(0, 1500)
    throw new Error(
      `worktree verification failed: ${worktree.path} does not agree with HEAD ${head}:\n${detail}`,
    )
  }
}

/**
 * Put the caller's complete visible git state into a newly cut tree.
 *
 * Opt-in at the launch. The default is off, and that will look wrong: this
 * function exists so an architect iterating on unfinished work can dispatch a
 * run and have the worker see it. The asymmetry is what decides the default.
 * Not carrying fails as a worker that lacks context and says so — visible,
 * recoverable, cheap. Carrying fails as another author's half-finished work
 * inside a diff that is then judged, scored and possibly landed as the
 * worker's — silent, and it corrupts the evidence the whole system runs on.
 *
 * The patch is against the destination's actual base, not necessarily the
 * caller's HEAD. That matters for project-owned worktree tools which choose
 * their own floor: the resulting tracked files still exactly match what the
 * caller was looking at, including committed branch work, staged changes,
 * unstaged changes, deletions and binary files. Untracked, non-ignored paths
 * are copied separately because no git diff can contain them.
 *
 * Ignored files are deliberately left to the project's worktree recipe. They
 * are environment (dependencies, databases, generated .env files), not review
 * input, and copying them would both defeat provisioning and turn one checkout's
 * runtime state into another's.
 */

function createFromRecipe(
  tool: WorktreeTool,
  recipe: Recipe,
  repoRoot: string,
  runId: string,
  key?: string,
  baseRef?: string,
  record?: RecordWorktree,
  detached = false,
  existingBranch?: string,
  recordRecipeResource?: RecordRecipeResource,
  claimRecipePort?: ClaimRecipePort,
): Worktree {
  const { branch, path } = recipeWorktreeIdentity(tool, repoRoot, runId, key, existingBranch)
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    throw new Error(`worktree ${path} already exists; run ${runId} would overwrite it`)
  }
  if (shouldCheckoutCreatedBranch(detached, existingBranch)) {
    assertBranchRefMayBeCreated(repoRoot, branch)
  }

  // An explicit caller base wins. Without one, the base is the project's to
  // choose: two of these repos branch from origin/develop and one from local
  // HEAD, and branching from the wrong one hands a worker a tree the spec does
  // not describe.
  const base = baseRef
    ? resolveBase(repoRoot, baseRef)
    : recipe.baseRef
      ? (gitOk(['rev-parse', recipe.baseRef], repoRoot) ?? git(['rev-parse', 'HEAD'], repoRoot))
      : git(['rev-parse', 'HEAD'], repoRoot)

  // branch-ref-guard: assertBranchRefMayBeCreated
  git(
    [
      'worktree',
      'add',
      ...(detached ? ['--detach'] : existingBranch ? [] : ['-b', branch]),
      path,
      existingBranch && !detached ? branch : base,
    ],
    repoRoot,
  )
  const w: Worktree = {
    path,
    branch: detached ? '' : branch,
    base,
    repoRoot,
    source: 'recipe',
    mintedBranch: detached || existingBranch ? null : branch,
  }
  attributeWorktree(w, runId, record)

  const steps = runRecordedRecipe(w, recipe, runId, recordRecipeResource, claimRecipePort)
  const failed = steps.find((r) => !r.ok)
  if (failed) {
    removeFor(w, repoRoot, false, false, runId)
    settleCreateTimeBranchCleanup(w, runId)
    throw new Error(`worktree setup failed at "${failed.step}":\n${failed.detail.slice(-1200)}`)
  }
  try {
    verifyFreshWorktree(w)
  } catch (e) {
    removeFor(w, repoRoot, false, false, runId)
    settleCreateTimeBranchCleanup(w, runId)
    throw e
  }
  return w
}

function recipeWorktreeIdentity(
  tool: WorktreeTool,
  repoRoot: string,
  runId: string,
  key?: string,
  existingBranch?: string,
  requestedBranch?: string,
): { branch: string; name: string; path: string } {
  const branch =
    existingBranch ??
    requestedBranch ??
    (tool.branch ?? 'orch/{id}').replace(/\{id\}/g, String(runId)).replace(/\{key\}/g, key ?? '')
  const name = `orch-${runId}`
  return { branch, name, path: join(repoRoot, '.claude', 'worktrees', name) }
}
