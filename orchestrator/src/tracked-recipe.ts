// concern: tracked recipe execution
/** Executes validated tracked lifecycle plans and records the immutable recipe used by a tree. */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { db, nowIso, writeTransaction } from './db.ts'
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
import {
  claimIndex,
  claimRecipePort,
  claimString,
  fillStringAllocationTemplate,
  RECIPE_PORT_BAND,
  releaseRecipeAllocationClaims,
} from './resource-claims.ts'
import { resolveBase } from './worktree-caller.ts'
import type { Worktree } from './worktree-types.ts'

export type RecipeSnapshot = {
  source: { path: string; commit: string }
  recipe: TrackedRecipe
  allocations?: RecipeAllocations
}
export type RecipeAllocations = {
  index: number
  ports: Record<string, number>
  strings: Record<string, string>
}
export type AllocationAttempt = { allocations: RecipeAllocations; insertedClaimIds: number[] }
export type TrackedAllocator = {
  allocate(input: {
    runId: number
    recipe: TrackedRecipe
    staticVars: Record<string, string>
  }): AllocationAttempt
  release(attempt: AllocationAttempt, reason: string): void
}
type StepRunner = (step: Step, context: StepContext) => StepResult

export const trackedAllocator: TrackedAllocator = {
  allocate(input) {
    return writeTransaction(() => {
      const database = db()
      const owner = database
        .query(
          `SELECT COALESCE(parent_run_id,id) root_run_id,project_id
           FROM run WHERE id=?`,
        )
        .get(input.runId) as { root_run_id: number; project_id: number | null } | null
      if (!owner?.project_id) {
        throw new Error(`tracked recipe allocation for run ${input.runId} requires a project`)
      }
      const before = (
        database.query('SELECT COALESCE(MAX(id),0) id FROM resource_claim').get() as { id: number }
      ).id
      const identity = {
        rootRunId: owner.root_run_id,
        runId: input.runId,
        projectId: owner.project_id,
        claimedAt: nowIso(),
      }
      const index = claimIndex(database, identity)
      const ports: Record<string, number> = {}
      for (const name of input.recipe.allocate?.ports ?? []) {
        ports[name] = claimRecipePort(database, { ...identity, band: RECIPE_PORT_BAND, name })
      }
      const strings: Record<string, string> = {}
      const stringVars = { ...input.staticVars, index: String(index) }
      for (const [name, template] of Object.entries(input.recipe.allocate?.strings ?? {})) {
        const value = fillStringAllocationTemplate(name, template, stringVars)
        strings[name] = claimString(database, { ...identity, name, value })
      }
      const insertedClaimIds = (
        database
          .query(
            `SELECT id FROM resource_claim
             WHERE id>? AND root_run_id=? AND run_id=? AND kind IN ('port','index','string')
             ORDER BY id`,
          )
          .all(before, owner.root_run_id, input.runId) as { id: number }[]
      ).map((row) => row.id)
      return { allocations: { index, ports, strings }, insertedClaimIds }
    })
  },
  release(attempt, reason) {
    writeTransaction(() => {
      releaseRecipeAllocationClaims(db(), {
        claimIds: attempt.insertedClaimIds,
        settledAt: nowIso(),
        reason,
      })
    })
  },
}

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

export function executeTrackedPreSteps(
  recipe: TrackedRecipe,
  context: StepContext,
  allocationAttempt: AllocationAttempt,
  allocator: TrackedAllocator,
  runStep: StepRunner,
): void {
  try {
    for (const step of recipe.pre ?? []) {
      const result = runStep(step, context)
      if (result.status !== 'ok') {
        throw new Error(
          `worktree pre-check failed at "${result.name}" (${result.phase}): ${result.detail}`,
        )
      }
    }
  } catch (error) {
    allocator.release(allocationAttempt, String((error as Error)?.message ?? error))
    throw error
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

function prepareTrackedCreate(
  input: TrackedCreateInput,
  allocator: TrackedAllocator,
  runStep: StepRunner,
): {
  base: string
  recipe: TrackedRecipe
  snapshot: RecipeSnapshot
  vars: Record<string, string>
  allocationAttempt: AllocationAttempt
} {
  const loaded = loadRecipeAtBase(input)
  const refusal = trackedExecutionRefusal(loaded.recipe)
  if (refusal) throw new Error(refusal)
  const staticVars = {
    branch: input.branch,
    name: input.name,
    base: loaded.base,
    key: input.key ?? '',
    seed: input.seed ?? '',
    path: input.path,
    main: input.repoRoot,
  }
  const allocationAttempt = allocator.allocate({
    runId: input.runId,
    recipe: loaded.recipe,
    staticVars,
  })
  const { allocations } = allocationAttempt
  const vars: Record<string, string> = { ...staticVars, index: String(allocations.index) }
  for (const [portName, port] of Object.entries(allocations.ports)) {
    vars[`ports.${portName}`] = String(port)
  }
  for (const [allocationName, value] of Object.entries(allocations.strings)) {
    vars[`alloc.${allocationName}`] = value
  }
  executeTrackedPreSteps(
    loaded.recipe,
    { treeRoot: input.repoRoot, vars },
    allocationAttempt,
    allocator,
    runStep,
  )
  return {
    base: loaded.base,
    recipe: loaded.recipe,
    snapshot: { ...loaded.snapshot, allocations },
    vars,
    allocationAttempt,
  }
}

function failTrackedCreation(input: {
  createInput: TrackedCreateInput
  worktree: Worktree
  snapshot: RecipeSnapshot
  allocationAttempt: AllocationAttempt
  allocator: TrackedAllocator
  creation: { failure: StepResult; compensation: StepResult[] }
}): never {
  const result = input.creation.failure
  const undoFailure = lifecycleFailure(input.creation.compensation)
  const setup = `worktree setup failed at "${result.name}" (${result.phase}): ${result.detail}`
  if (!undoFailure) {
    const removal = input.createInput.remove(input.worktree)
    if (removal.removed) {
      input.allocator.release(input.allocationAttempt, setup)
      throw new Error(setup)
    }
    writeSnapshot(input.createInput.runId, input.snapshot)
    throw new Error(
      `${setup}; removal failed: ${removal.detail}; tree retained at ${input.createInput.path}`,
    )
  }
  writeSnapshot(input.createInput.runId, input.snapshot)
  throw new Error(
    `${setup}; compensation failed at "${undoFailure.name}" (undo): ${undoFailure.detail}; tree retained at ${input.createInput.path}`,
  )
}

export function createTrackedRecipe(
  input: TrackedCreateInput,
  runStep: StepRunner = kernelRunStep,
  runUndo: StepRunner = kernelRunUndo,
  allocator: TrackedAllocator = trackedAllocator,
): Worktree {
  const { branch, path } = input
  if (existsSync(path))
    throw new Error(`worktree ${path} already exists; run ${input.runId} would overwrite it`)

  const prepared = prepareTrackedCreate(input, allocator, runStep)
  const { base, snapshot, vars } = prepared

  try {
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
  } catch (error) {
    // No worktree claim exists yet, so nothing else would ever release these.
    allocator.release(prepared.allocationAttempt, String((error as Error)?.message ?? error))
    throw error
  }
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
  const creation = executeTrackedCreateSteps(prepared.recipe, context, runStep, runUndo)
  if (creation.failure) {
    failTrackedCreation({
      createInput: input,
      worktree,
      snapshot,
      allocationAttempt: prepared.allocationAttempt,
      allocator,
      creation: { failure: creation.failure, compensation: creation.compensation },
    })
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
    allocations: stored.snapshot.allocations,
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
