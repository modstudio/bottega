// concern: tracked recipe execution
/** Executes validated tracked lifecycle plans and records the immutable recipe used by a tree. */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { db } from './db.ts'
import { git, gitOk } from './git-environment.ts'
import type { WorktreeTool } from './projects.ts'
import {
  compensationPlan,
  destroyPlan,
  lifecycleFailure,
  teardownVars,
  trackedExecutionRefusal,
} from './recipe-lifecycle.ts'
import { parseTrackedRecipe } from './recipe-loader.ts'
import type { TrackedRecipe } from './recipe-schema.ts'
import {
  runStep as kernelRunStep,
  runUndo as kernelRunUndo,
  type Step,
  type StepContext,
  type StepResult,
} from './recipe-step.ts'
import { resolveBase } from './worktree-caller.ts'
import type { Worktree } from './worktree-types.ts'

export type RecipeSnapshot = {
  source: { path: string; commit: string }
  recipe: TrackedRecipe
}
type StepRunner = (step: Step, context: StepContext) => StepResult

function loadRecipeAtBase(input: TrackedCreateInput): {
  base: string
  recipe: TrackedRecipe
  snapshot: RecipeSnapshot
} {
  const pointer = input.tool.recipePath!
  let base = input.baseRef
    ? resolveBase(input.repoRoot, input.baseRef)
    : git(['rev-parse', 'HEAD'], input.repoRoot)
  const read = () => {
    let source: string
    try {
      source = git(['show', `${base}:${pointer}`], input.repoRoot)
    } catch (error) {
      throw new Error(
        `tracked recipe ${pointer} at ${base} could not be read: ${String((error as Error)?.message ?? error)}`,
      )
    }
    const loaded = parseTrackedRecipe(source, `${pointer} at ${base}`)
    if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
    return loaded.recipe
  }
  let recipe = read()
  if (!input.baseRef && recipe.baseRef) {
    base =
      gitOk(['rev-parse', recipe.baseRef], input.repoRoot) ??
      git(['rev-parse', 'HEAD'], input.repoRoot)
    recipe = read()
  }
  return { base, recipe, snapshot: { source: { path: pointer, commit: base }, recipe } }
}

export function executeTrackedCreateSteps(
  recipe: TrackedRecipe,
  context: StepContext,
  runStep: StepRunner,
  runUndo: StepRunner,
): { failure: StepResult | null; compensation: StepResult[] } {
  for (const [index, step] of recipe.create.entries()) {
    const failure = runStep(step, context)
    if (failure.status !== 'ok') {
      return {
        failure,
        compensation: compensationPlan(recipe, index).map((item) => runUndo(item, context)),
      }
    }
  }
  return { failure: null, compensation: [] }
}

function runPreSteps(recipe: TrackedRecipe, context: StepContext, runStep: StepRunner): void {
  for (const step of recipe.pre ?? []) {
    const result = runStep(step, context)
    if (result.status !== 'ok') {
      throw new Error(
        `worktree pre-check failed at "${result.name}" (${result.phase}): ${result.detail}`,
      )
    }
  }
}

function writeSnapshot(runId: number, snapshot: RecipeSnapshot): void {
  db()
    .query(
      `UPDATE run SET recipe_snapshot=? WHERE id=(SELECT COALESCE(parent_run_id,id) FROM run WHERE id=?)`,
    )
    .run(JSON.stringify(snapshot), runId)
}

function readSnapshot(runId: number): {
  snapshot: RecipeSnapshot | null
  key: string | null
  seed: string | null
} {
  const row = db()
    .query(
      `SELECT recipe_snapshot snapshot, launch_key key, launch_seed seed FROM run
       WHERE id=(SELECT COALESCE(parent_run_id,id) FROM run WHERE id=?)`,
    )
    .get(runId) as { snapshot: string | null; key: string | null; seed: string | null } | null
  return {
    snapshot: row?.snapshot ? (JSON.parse(row.snapshot) as RecipeSnapshot) : null,
    key: row?.key ?? null,
    seed: row?.seed ?? null,
  }
}

export type TrackedCreateInput = {
  tool: WorktreeTool
  repoRoot: string
  runId: number
  seed?: string
  key?: string
  baseRef?: string
  detached?: boolean
  existingBranch?: string
  branch: string
  name: string
  path: string
  attribute(worktree: Worktree): void
  verify(worktree: Worktree): void
  remove(worktree: Worktree): { removed: boolean; detail: string }
  removeProvisioned(worktree: Worktree): { removed: boolean; detail: string }
}

export function createTrackedRecipe(
  input: TrackedCreateInput,
  runStep: StepRunner = kernelRunStep,
  runUndo: StepRunner = kernelRunUndo,
): Worktree {
  const { branch, name, path } = input
  if (existsSync(path))
    throw new Error(`worktree ${path} already exists; run ${input.runId} would overwrite it`)

  const loaded = loadRecipeAtBase(input)
  const { base } = loaded
  const refusal = trackedExecutionRefusal(loaded.recipe)
  if (refusal) throw new Error(refusal)
  const { snapshot } = loaded
  const vars = {
    branch,
    name,
    base,
    key: input.key ?? '',
    seed: input.seed ?? '',
    path,
    main: input.repoRoot,
  }
  const preContext = { treeRoot: input.repoRoot, vars }
  runPreSteps(loaded.recipe, preContext, runStep)

  mkdirSync(dirname(path), { recursive: true })
  git(
    [
      'worktree',
      'add',
      ...(input.detached ? ['--detach'] : input.existingBranch ? [] : ['-b', branch]),
      path,
      input.existingBranch && !input.detached ? branch : base,
    ],
    input.repoRoot,
  )
  const worktree: Worktree = {
    path,
    branch: input.detached ? '' : branch,
    base,
    repoRoot: input.repoRoot,
    source: 'recipe',
    mintedBranch: input.detached || input.existingBranch ? null : branch,
  }
  input.attribute(worktree)
  const context = { treeRoot: path, vars }
  const creation = executeTrackedCreateSteps(loaded.recipe, context, runStep, runUndo)
  if (creation.failure) {
    const result = creation.failure
    const undoFailure = lifecycleFailure(creation.compensation)
    const setup = `worktree setup failed at "${result.name}" (${result.phase}): ${result.detail}`
    if (!undoFailure) {
      input.remove(worktree)
      throw new Error(setup)
    }
    writeSnapshot(input.runId, snapshot)
    throw new Error(
      `${setup}; compensation failed at "${undoFailure.name}" (undo): ${undoFailure.detail}; tree retained at ${path}`,
    )
  }
  writeSnapshot(input.runId, snapshot)
  try {
    input.verify(worktree)
  } catch (error) {
    input.removeProvisioned(worktree)
    throw error
  }
  return worktree
}

export function teardownTrackedRecipe(
  input: {
    runId: number
    worktree: Worktree
    remove(): { removed: boolean; detail: string }
    stored?: { snapshot: RecipeSnapshot | null; key: string | null; seed: string | null }
    treeExists?: boolean
  },
  runStep: StepRunner = kernelRunStep,
  runUndo: StepRunner = kernelRunUndo,
): { removed: boolean; detail: string } {
  const stored = input.stored ?? readSnapshot(input.runId)
  if (!stored.snapshot)
    return {
      removed: false,
      detail: 'tracked recipe tree has no recorded recipe snapshot; teardown cannot be established',
    }
  const vars = teardownVars({
    path: input.worktree.path,
    branch: input.worktree.branch,
    base: stored.snapshot.source.commit,
    key: stored.key,
    seed: stored.seed,
    main: input.worktree.repoRoot,
  })
  const treeExists = input.treeExists ?? existsSync(input.worktree.path)
  const context = { treeRoot: treeExists ? input.worktree.path : input.worktree.repoRoot, vars }
  const results = destroyPlan(stored.snapshot.recipe).map(({ step, phase }) =>
    phase === 'run' ? runStep(step, context) : runUndo(step, context),
  )
  for (const step of stored.snapshot.recipe.verifyDown ?? []) results.push(runStep(step, context))
  const failed = lifecycleFailure(results)
  return failed
    ? {
        removed: false,
        detail: `recipe teardown failed at "${failed.name}" (${failed.phase}): ${failed.detail}`,
      }
    : input.remove()
}
