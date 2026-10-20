// concern: tracked recipe execution
/** Executes validated tracked lifecycle plans and records the immutable recipe used by a tree. */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { settleCreateTimeBranchCleanup } from '../branch/create-time-settlement.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { git } from '../git/git-environment.ts'
import { projects, type WorktreeTool } from '../project/projects.ts'
import { dockerRunResources, orchRunLabelForRun } from '../resources/docker-resources.ts'
import {
  claimDatabaseName,
  claimIndex,
  claimRecipePort,
  claimString,
  fillStringAllocationTemplate,
  RECIPE_PORT_BAND,
  releaseRecipeAllocationClaims,
  settleClaims,
} from '../resources/resource-claims.ts'
import { appendProvisioningPhases } from '../worktree/provisioning-measurement.ts'
import { type ProvisionSkip, provisionWorktree } from '../worktree/worktree-provision.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { type ComposeSpawn, createCompose, downCompose } from './compose-provision.ts'
import { composeProjectName } from './compose-provision-plan.ts'
import { createProvisionedDatabases, dropProvisionedDatabases } from './database-provision.ts'
import {
  compensationPlan,
  destroyPlan,
  lifecycleFailure,
  serveUndoPlan,
  sharedDeclarations,
  snapshotlessTeardown,
  teardownVars,
  trackedTeardownFailure,
} from './recipe-lifecycle.ts'
import { loadRecipeAtBase } from './recipe-loader.ts'
import {
  allocationEnvironmentVariable,
  hookBranchName,
  type TrackedRecipe,
} from './recipe-schema.ts'
import {
  runStep as kernelRunStep,
  runUndo as kernelRunUndo,
  type Step,
  type StepContext,
  type StepResult,
} from './recipe-step.ts'
import { databaseUrlSecrets, writeTrackedEnvFiles } from './tracked-env-files.ts'
import {
  startTrackedTeardownMainStack,
  stopTrackedTeardownMainStack,
} from './tracked-recipe-main-stack.ts'
import type {
  AllocationAttempt,
  RecipeAllocations,
  RecipeSnapshot,
} from './tracked-recipe-types.ts'

export type {
  AllocationAttempt,
  RecipeAllocations,
  RecipeSnapshot,
} from './tracked-recipe-types.ts'
export type TrackedAllocator = {
  allocate(input: {
    runId: string
    recipe: TrackedRecipe
    staticVars: Record<string, string>
  }): AllocationAttempt
  release(attempt: AllocationAttempt, reason: string): void
}
type StepRunner = (step: Step, context: StepContext) => StepResult

function measureProvisioningPhase<T>(
  runId: string,
  phase: string,
  name: string,
  operation: () => T,
): T {
  const started = performance.now()
  try {
    return operation()
  } finally {
    appendProvisioningPhases(runId, [{ phase, name, durationMs: performance.now() - started }])
  }
}

function provisionTrackedDependencies(
  input: TrackedCreateInput,
  path: string,
  snapshot: RecipeSnapshot,
) {
  return measureProvisioningPhase(input.runId, 'dependency', 'declared dependencies', () =>
    provisionWorktree(
      input.repoRoot,
      path,
      snapshot.recipe.provision ?? [],
      `tracked recipe "${snapshot.source.path}"`,
    ),
  )
}

function recordTrackedCreateSteps(runId: string, results: readonly StepResult[]): void {
  appendProvisioningPhases(
    runId,
    results.map((result) => ({
      phase: 'create',
      name: result.name,
      durationMs: result.durationMs,
    })),
  )
}

function writeTrackedEnvironment(
  input: TrackedCreateInput,
  recipe: TrackedRecipe,
  context: StepContext,
  secrets: Record<string, string>,
): StepResult | null {
  return measureProvisioningPhase(input.runId, 'env', 'env files', () =>
    writeTrackedEnvFiles(recipe, context, input.repoRoot, secrets),
  )
}

function composeContext(input: {
  runId: string
  treeRoot: string
  commandRoot?: string
  treeExists?: boolean
}):
  | {
      ok: true
      context: {
        treeRoot: string
        commandRoot?: string
        treeExists?: boolean
        projectName: string
        rootRunId: string
        mainComposeProjects: string[]
      }
    }
  | { ok: false; failure: StepResult } {
  const owner = db()
    .query(
      `SELECT COALESCE(r.parent_run_record_id,r.record_id) root_run_record_id,p.name project_name
       FROM run r JOIN project p ON p.record_id=r.project_record_id WHERE r.record_id=?`,
    )
    .get(input.runId) as { root_run_record_id: string; project_name: string } | null
  if (!owner) {
    return {
      ok: false,
      failure: {
        name: 'compose',
        phase: 'verify',
        status: 'refused',
        exitCode: null,
        argv: null,
        detail: `run ${input.runId} has no registered project; attach it to a project and retry`,
        durationMs: 0,
      },
    }
  }
  const inventory = dockerRunResources(projects().map((project) => project.path))
  if (!inventory.ascertainable) {
    return {
      ok: false,
      failure: {
        name: 'compose',
        phase: 'verify',
        status: 'failed',
        exitCode: null,
        argv: null,
        detail: `${inventory.reason}; restore Docker access and retry`,
        durationMs: 0,
      },
    }
  }
  const mainComposeProjects = new Set(
    inventory.resources.flatMap((resource) =>
      resource.mainCheckout && resource.composeProject ? [resource.composeProject] : [],
    ),
  )
  for (const container of inventory.composeContainers ?? []) {
    if (container.mainCheckout) mainComposeProjects.add(container.composeProject)
  }
  return {
    ok: true,
    context: {
      ...input,
      projectName: owner.project_name,
      rootRunId: owner.root_run_record_id,
      mainComposeProjects: [...mainComposeProjects],
    },
  }
}

export const trackedAllocator: TrackedAllocator = {
  allocate(input) {
    return writeTransaction(() => {
      const database = db()
      const owner = database
        .query(
          `SELECT COALESCE(parent_run_record_id,record_id) root_run_record_id,project_record_id
           FROM run WHERE record_id=?`,
        )
        .get(input.runId) as { root_run_record_id: string; project_record_id: string | null } | null
      if (!owner?.project_record_id) {
        throw new Error(`tracked recipe allocation for run ${input.runId} requires a project`)
      }
      const before = (
        database.query('SELECT COALESCE(MAX(id),0) id FROM resource_claim').get() as { id: number }
      ).id
      const identity = {
        rootRunId: owner.root_run_record_id,
        runId: input.runId,
        projectId: owner.project_record_id,
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
      const databases: Record<string, string> = {}
      for (const [name, allocation] of Object.entries(input.recipe.allocate?.databases ?? {})) {
        const value = fillStringAllocationTemplate(name, allocation.name, stringVars)
        databases[name] = claimDatabaseName(database, {
          ...identity,
          name,
          engine: allocation.engine,
          value,
        })
      }
      const insertedClaimIds = (
        database
          .query(
            `SELECT id FROM resource_claim
             WHERE id>? AND root_run_record_id=? AND run_record_id=? AND kind IN ('port','index','string','database')
             ORDER BY id`,
          )
          .all(before, owner.root_run_record_id, input.runId) as { id: number }[]
      ).map((row) => row.id)
      return { allocations: { index, ports, databases, strings }, insertedClaimIds }
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

/** Read the same tracked config used by creation and decide its hook branch. */
export function trackedHookBranch(input: {
  tool: WorktreeTool
  repoRoot: string
  baseRef?: string
  name: string
}): string {
  const { recipe } = loadRecipeAtBase({ ...input, recipePath: input.tool.recipePath! })
  return hookBranchName(recipe.hookBranch, input.name)
}

function renderedPlaceholder(name: string): string {
  if (name === 'main') return name
  if (name === 'tree_exists') return 'true'
  if (name === 'index') return '$ORCH_INDEX'
  if (name === 'label') return '$ORCH_RUN_LABEL'
  const allocation = name.match(/^(ports|db|alloc)\.(.+)$/)
  if (allocation) {
    return `$${allocationEnvironmentVariable(
      allocation[1] as 'ports' | 'db' | 'alloc',
      allocation[2]!,
    )}`
  }
  return `<${name}>`
}

function renderCommand(command: Step['run'], main: string): string {
  const render = (value: string) =>
    value.replace(/\{([^{}]+)\}/g, (_placeholder, name: string) => {
      const rendered = renderedPlaceholder(name)
      return rendered === 'main' ? main : rendered
    })
  const args = command.args.flatMap((arg) => {
    if (typeof arg === 'string') return [render(arg)]
    if ('expand' in arg) return ['<seed>']
    return [render(arg.value)]
  })
  return [render(command.command), ...args].join(' ')
}

/** Render serve declarations without executing them or requiring allocated values yet. */
export function renderTrackedRecipeNotes(recipe: TrackedRecipe, main: string): string {
  const entries = Object.entries(recipe.serve ?? {})
  const modes = entries.some(([mode]) => mode === 'default')
    ? [
        ...entries.filter(([mode]) => mode === 'default'),
        ...entries.filter(([mode]) => mode !== 'default'),
      ]
    : entries
  const lines: string[] = []
  for (const [mode, steps] of modes) {
    lines.push(`serve mode ${mode}:`)
    for (const step of steps) {
      lines.push(`  ${renderCommand(step.run, main)}   ${step.name}`)
      lines.push(`  stop: ${renderCommand(step.undo!, main)}`)
    }
  }
  if (modes.length) {
    lines.push('NEVER verify against a server you did not start for this worktree. Borrowing one')
    lines.push('tests a different branch and PASSES, which is worse than failing.')
  }
  const shared = sharedDeclarations(recipe)
  if (shared.length) {
    lines.push('shared declarations:')
    lines.push(...shared.map((declaration) => `  ${declaration}`))
  }
  return lines.join('\n')
}

/** Best-effort prompt notes from the same committed recipe source used by creation. */
export function trackedRecipeNotes(tool: WorktreeTool, repoRoot: string): string {
  if (!tool.recipePath) return ''
  try {
    const loaded = loadRecipeAtBase({ recipePath: tool.recipePath, repoRoot })
    return renderTrackedRecipeNotes(loaded.recipe, repoRoot)
  } catch {
    return ''
  }
}

export function recipeAllocationEnvironment(
  allocations: RecipeAllocations | undefined,
  rootRunId?: string,
): Record<string, string> {
  const environment: Record<string, string> = {}
  if (rootRunId !== undefined) environment.ORCH_RUN_LABEL = orchRunLabelForRun(rootRunId)
  if (!allocations) return environment
  environment.ORCH_INDEX = String(allocations.index)
  for (const [name, port] of Object.entries(allocations.ports)) {
    environment[allocationEnvironmentVariable('ports', name)] = String(port)
  }
  for (const [name, value] of Object.entries(allocations.databases ?? {})) {
    environment[allocationEnvironmentVariable('db', name)] = value
  }
  for (const [name, value] of Object.entries(allocations.strings)) {
    environment[allocationEnvironmentVariable('alloc', name)] = value
  }
  return environment
}

export function trackedRecipeVars(
  staticVars: Record<string, string>,
  allocations: RecipeAllocations,
  rootRunId: string,
  compose?: { projectName: string },
): Record<string, string> {
  const vars: Record<string, string> = {
    ...staticVars,
    index: String(allocations.index),
    label: orchRunLabelForRun(rootRunId),
    tree_exists: 'true',
    ...(compose ? { 'compose.project': composeProjectName(compose.projectName, rootRunId) } : {}),
  }
  for (const [portName, port] of Object.entries(allocations.ports)) {
    vars[`ports.${portName}`] = String(port)
  }
  for (const [databaseName, value] of Object.entries(allocations.databases)) {
    vars[`db.${databaseName}`] = value
  }
  for (const [allocationName, value] of Object.entries(allocations.strings)) {
    vars[`alloc.${allocationName}`] = value
  }
  return vars
}

function composeVariableIdentity(
  recipe: TrackedRecipe,
  projectName: string | null | undefined,
  rootRunId: string | undefined,
): { projectName: string; rootRunId: string } | undefined {
  if (!recipe.compose || !projectName || rootRunId === undefined) return undefined
  return { projectName, rootRunId }
}

export function trackedRecipeEnvironment(runId: string): Record<string, string> {
  const stored = readSnapshot(runId)
  return recipeAllocationEnvironment(stored.snapshot?.allocations, stored.rootRunId)
}

export function executeTrackedCreateSteps(
  recipe: TrackedRecipe,
  context: StepContext,
  runStep: StepRunner,
  runUndo: StepRunner,
): { failure: StepResult | null; compensation: StepResult[]; results: StepResult[] } {
  const results: StepResult[] = []
  for (const [index, step] of recipe.create.entries()) {
    const failure = runStep(step, context)
    results.push(failure)
    if (failure.status !== 'ok') {
      return {
        failure,
        compensation: compensationPlan(recipe, index).map((item) => runUndo(item, context)),
        results,
      }
    }
  }
  return { failure: null, compensation: [], results }
}

export function executeTrackedRefreshSteps(
  recipe: TrackedRecipe,
  context: StepContext,
  runStep: StepRunner,
): StepResult | null {
  for (const step of recipe.refresh ?? []) {
    const result = runStep(step, context)
    if (result.status !== 'ok') return result
  }
  return null
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

function writeSnapshot(runId: string, snapshot: RecipeSnapshot): void {
  db()
    .query(
      `UPDATE run SET recipe_snapshot=?, resource_teardown='pending'
       WHERE record_id=(SELECT COALESCE(parent_run_record_id,record_id) FROM run WHERE record_id=?)`,
    )
    .run(JSON.stringify(snapshot), runId)
}

function recordedRecipe(recipe: TrackedRecipe): TrackedRecipe {
  const recorded = { ...recipe }
  delete recorded.env
  return recorded
}

function liveDatabaseClaims(runId: string): number {
  return (
    db()
      .query(
        `SELECT COUNT(*) count FROM resource_claim
         WHERE root_run_record_id=(SELECT COALESCE(parent_run_record_id,record_id) FROM run WHERE record_id=?)
           AND kind='database' AND state='claimed'`,
      )
      .get(runId) as { count: number }
  ).count
}

export function readSnapshot(runId: string): {
  snapshot: RecipeSnapshot | null
  key: string | null
  seed: string | null
  rootRunId: string
  projectName: string | null
} {
  const row = db()
    .query(
      `SELECT r.record_id root_run_record_id,r.recipe_snapshot snapshot,r.launch_key key,r.launch_seed seed,
              p.name project_name
       FROM run r LEFT JOIN project p ON p.record_id=r.project_record_id
       WHERE r.record_id=(SELECT COALESCE(parent_run_record_id,record_id) FROM run WHERE record_id=?)`,
    )
    .get(runId) as {
    root_run_record_id: string
    snapshot: string | null
    key: string | null
    seed: string | null
    project_name: string | null
  } | null
  return {
    snapshot: row?.snapshot ? (JSON.parse(row.snapshot) as RecipeSnapshot) : null,
    key: row?.key ?? null,
    seed: row?.seed ?? null,
    rootRunId: row?.root_run_record_id ?? runId,
    projectName: row?.project_name ?? null,
  }
}

export type TrackedCreateInput = {
  tool: WorktreeTool
  repoRoot: string
  runId: string
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
  const loaded = loadRecipeAtBase({
    recipePath: input.tool.recipePath!,
    repoRoot: input.repoRoot,
    baseRef: input.baseRef,
  })
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
  const owner = readSnapshot(input.runId)
  const compose = composeVariableIdentity(loaded.recipe, owner.projectName, owner.rootRunId)
  if (loaded.recipe.compose && !compose) {
    allocator.release(allocationAttempt, `run ${input.runId} has no registered project`)
    throw new Error(
      `run ${input.runId} has no registered project; attach it to a project and retry`,
    )
  }
  const vars = trackedRecipeVars(staticVars, allocations, owner.rootRunId, compose)
  executeTrackedPreSteps(
    loaded.recipe,
    { treeRoot: input.repoRoot, vars: { ...vars, tree_exists: 'false' } },
    allocationAttempt,
    allocator,
    runStep,
  )
  return {
    base: loaded.base,
    recipe: loaded.recipe,
    snapshot: {
      ...loaded.snapshot,
      recipe: recordedRecipe(loaded.snapshot.recipe),
      allocations,
    },
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
    settleCreateTimeBranchCleanup(input.worktree, input.createInput.runId)
    if (removal.removed) {
      writeTransaction(() => {
        const database = db()
        const run = database
          .query(
            'SELECT COALESCE(parent_run_record_id,record_id) root_id FROM run WHERE record_id=?',
          )
          .get(input.createInput.runId) as { root_id: string } | null
        database
          .query('UPDATE run SET worktree=NULL WHERE record_id=? AND worktree=?')
          .run(input.createInput.runId, input.worktree.path)
        if (run) {
          settleClaims(database, {
            rootRunId: run.root_id,
            kind: 'worktree',
            state: 'released',
            settledAt: nowIso(),
            detail: setup,
            allocationKey: input.worktree.path,
          })
        }
      })
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

type PreparedComposeContext = Extract<ReturnType<typeof composeContext>, { ok: true }>['context']

function createTrackedCompose(input: {
  createInput: TrackedCreateInput
  worktree: Worktree
  recipe: TrackedRecipe
  snapshot: RecipeSnapshot
  allocationAttempt: AllocationAttempt
  allocator: TrackedAllocator
  spawn?: ComposeSpawn
}): PreparedComposeContext | null {
  if (!input.recipe.compose) {
    input.snapshot.composeOwnership = false
    return null
  }
  const prepared = composeContext({
    runId: input.createInput.runId,
    treeRoot: input.createInput.path,
  })
  if (!prepared.ok) {
    failTrackedCreation({
      createInput: input.createInput,
      worktree: input.worktree,
      snapshot: input.snapshot,
      allocationAttempt: input.allocationAttempt,
      allocator: input.allocator,
      creation: { failure: prepared.failure, compensation: [] },
    })
  }
  const compose = createCompose(input.recipe, prepared.context, input.spawn, () => {
    input.snapshot.composeOwnership = true
    writeSnapshot(input.createInput.runId, input.snapshot)
  })
  input.snapshot.composeOwnership = compose.owned
  if (compose.step.status !== 'ok') {
    failTrackedCreation({
      createInput: input.createInput,
      worktree: input.worktree,
      snapshot: input.snapshot,
      allocationAttempt: input.allocationAttempt,
      allocator: input.allocator,
      creation: {
        failure: compose.step,
        compensation: compose.owned
          ? [downCompose(input.recipe, prepared.context, compose.owned)]
          : [],
      },
    })
  }
  return prepared.context
}

/** Build the one git worktree-add shape used by every tracked creation form. */
export function trackedWorktreeAddArgv(input: {
  branch: string
  path: string
  base: string
  detached: boolean
  existingBranch: boolean
  relativePaths?: boolean
}): string[] {
  return [
    'worktree',
    'add',
    ...(input.relativePaths ? ['--relative-paths'] : []),
    ...(input.detached ? ['--detach'] : input.existingBranch ? [] : ['-b', input.branch]),
    input.path,
    input.existingBranch && !input.detached ? input.branch : input.base,
  ]
}

/**
 * Missing optional sources are expected; retain diagnostics for every other
 * provisioning skip.
 */
function reportedProvisionSkips(skipped: readonly ProvisionSkip[]): ProvisionSkip[] {
  return skipped.filter((entry) => entry.reason !== 'missing source')
}

export function createTrackedRecipe(
  input: TrackedCreateInput,
  runStep: StepRunner = kernelRunStep,
  runUndo: StepRunner = kernelRunUndo,
  allocator: TrackedAllocator = trackedAllocator,
  composeSpawn?: ComposeSpawn,
): Worktree {
  const { branch, path } = input
  if (existsSync(path))
    throw new Error(`worktree ${path} already exists; run ${input.runId} would overwrite it`)

  const prepared = prepareTrackedCreate(input, allocator, runStep)
  const { base, snapshot, vars } = prepared

  try {
    mkdirSync(dirname(path), { recursive: true })
    git(
      trackedWorktreeAddArgv({
        branch,
        path,
        base,
        detached: Boolean(input.detached),
        existingBranch: Boolean(input.existingBranch),
        relativePaths: prepared.recipe.relativePaths,
      }),
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
  try {
    const skipped = provisionTrackedDependencies(input, path, snapshot)
    for (const entry of reportedProvisionSkips(skipped)) {
      console.error(`orch: provision skipped "${entry.path}": ${entry.reason}`)
    }
  } catch (error) {
    failTrackedCreation({
      createInput: input,
      worktree,
      snapshot,
      allocationAttempt: prepared.allocationAttempt,
      allocator,
      creation: {
        failure: {
          name: 'provision',
          phase: 'run',
          status: 'failed',
          exitCode: null,
          argv: null,
          detail: String((error as Error)?.message ?? error),
          durationMs: 0,
        },
        compensation: [],
      },
    })
  }
  const urls = databaseUrlSecrets(
    prepared.recipe,
    prepared.snapshot.allocations?.databases ?? {},
    input.repoRoot,
    context.vars.label!,
  )
  if (!urls.ok) {
    failTrackedCreation({
      createInput: input,
      worktree,
      snapshot,
      allocationAttempt: prepared.allocationAttempt,
      allocator,
      creation: { failure: urls.result, compensation: [] },
    })
  }
  const envFailure = writeTrackedEnvironment(input, prepared.recipe, context, urls.secrets)
  if (envFailure) {
    failTrackedCreation({
      createInput: input,
      worktree,
      snapshot,
      allocationAttempt: prepared.allocationAttempt,
      allocator,
      creation: { failure: envFailure, compensation: [] },
    })
  }
  const preparedComposeContext = measureProvisioningPhase(input.runId, 'compose', 'compose', () =>
    createTrackedCompose({
      createInput: input,
      worktree,
      recipe: prepared.recipe,
      snapshot,
      allocationAttempt: prepared.allocationAttempt,
      allocator,
      spawn: composeSpawn,
    }),
  )
  const databaseContext = {
    projectRoot: input.repoRoot,
    treeRoot: path,
    allocations: prepared.snapshot.allocations!.databases,
  }
  const databases = measureProvisioningPhase(input.runId, 'database', 'provisioned databases', () =>
    createProvisionedDatabases(prepared.recipe, databaseContext),
  )
  snapshot.databaseOwnership = databases.ownership
  if (databases.failure) {
    failTrackedCreation({
      createInput: input,
      worktree,
      snapshot,
      allocationAttempt: prepared.allocationAttempt,
      allocator,
      creation: {
        failure: databases.failure,
        compensation: [
          ...databases.compensation,
          ...(preparedComposeContext
            ? [downCompose(prepared.recipe, preparedComposeContext, snapshot.composeOwnership)]
            : []),
        ],
      },
    })
  }
  const creation = executeTrackedCreateSteps(prepared.recipe, context, runStep, runUndo)
  recordTrackedCreateSteps(input.runId, creation.results)
  if (creation.failure) {
    failTrackedCreation({
      createInput: input,
      worktree,
      snapshot,
      allocationAttempt: prepared.allocationAttempt,
      allocator,
      creation: {
        failure: creation.failure,
        compensation: [
          ...creation.compensation,
          ...dropProvisionedDatabases(prepared.recipe, databaseContext, snapshot.databaseOwnership),
          ...(preparedComposeContext
            ? [downCompose(prepared.recipe, preparedComposeContext, snapshot.composeOwnership)]
            : []),
        ],
      },
    })
  }
  writeSnapshot(input.runId, snapshot)
  try {
    measureProvisioningPhase(input.runId, 'verify', 'worktree', () => input.verify(worktree))
  } catch (error) {
    input.removeProvisioned(worktree)
    settleCreateTimeBranchCleanup(worktree, input.runId)
    throw error
  }
  return worktree
}

function settleTrackedTeardown(runId: string): void {
  writeTransaction(() => {
    const owner = db()
      .query(
        'SELECT COALESCE(parent_run_record_id,record_id) root_run_record_id FROM run WHERE record_id=?',
      )
      .get(runId) as { root_run_record_id: string } | null
    if (!owner) return
    settleClaims(db(), {
      rootRunId: owner.root_run_record_id,
      kind: 'database',
      state: 'released',
      settledAt: nowIso(),
      detail: 'tracked recipe teardown completed',
    })
    db()
      .query(
        "UPDATE run SET resource_teardown='done' WHERE record_id=? AND resource_teardown='pending'",
      )
      .run(owner.root_run_record_id)
  })
}

function runTrackedTeardown(input: {
  runId: string
  worktree: Worktree
  stored: {
    snapshot: RecipeSnapshot
    key: string | null
    seed: string | null
    rootRunId?: string
    projectName?: string | null
  }
  treeExists: boolean
  runStep: StepRunner
  runUndo: StepRunner
}): { results: StepResult[]; stopFailure: string | null; stopNote: string | null } {
  const { runId, worktree, stored, treeExists, runStep, runUndo } = input
  let mainStack: ReturnType<typeof startTrackedTeardownMainStack> | null = null
  let temporaryCwd: string | null = null
  const results: StepResult[] = []
  let stopFailure: string | null = null
  let stopNote: string | null = null
  try {
    mainStack = startTrackedTeardownMainStack(worktree)
    const vars = teardownVars({
      path: worktree.path,
      branch: worktree.branch,
      base: stored.snapshot.source.commit,
      key: stored.key,
      seed: stored.seed,
      main: worktree.repoRoot,
      label: orchRunLabelForRun(stored.rootRunId ?? readSnapshot(runId).rootRunId),
      treeExists,
      allocations: stored.snapshot.allocations,
      compose: composeVariableIdentity(
        stored.snapshot.recipe,
        stored.projectName,
        stored.rootRunId,
      ),
    })
    temporaryCwd = treeExists ? null : mkdtempSync(join(tmpdir(), 'orch-teardown-'))
    const context = { treeRoot: temporaryCwd ?? worktree.path, vars }
    results.push(...serveUndoPlan(stored.snapshot.recipe).map((step) => runUndo(step, context)))
    for (const { step, phase } of destroyPlan(stored.snapshot.recipe))
      results.push(phase === 'run' ? runStep(step, context) : runUndo(step, context))
    results.push(
      ...dropProvisionedDatabases(
        stored.snapshot.recipe,
        {
          projectRoot: worktree.repoRoot,
          treeRoot: worktree.path,
          commandRoot: context.treeRoot,
          allocations: stored.snapshot.allocations?.databases ?? {},
        },
        stored.snapshot.databaseOwnership,
      ),
    )
    if (stored.snapshot.recipe.compose) {
      const preparedComposeContext = composeContext({
        runId,
        treeRoot: worktree.path,
        commandRoot: context.treeRoot,
        treeExists,
      })
      results.push(
        preparedComposeContext.ok
          ? downCompose(
              stored.snapshot.recipe,
              preparedComposeContext.context,
              stored.snapshot.composeOwnership,
            )
          : preparedComposeContext.failure,
      )
    }
    for (const step of stored.snapshot.recipe.verifyDown ?? []) results.push(runStep(step, context))
  } finally {
    if (temporaryCwd) rmSync(temporaryCwd, { recursive: true, force: true })
    if (mainStack) {
      const stopped = stopTrackedTeardownMainStack(mainStack)
      stopFailure = stopped.failure
      stopNote = stopped.note
    }
  }
  return { results, stopFailure, stopNote }
}

export function teardownTrackedRecipe(
  input: {
    runId: string
    worktree: Worktree
    remove(): { removed: boolean; detail: string }
    stored?: {
      snapshot: RecipeSnapshot | null
      key: string | null
      seed: string | null
      rootRunId?: string
      projectName?: string | null
    }
    treeExists?: boolean
    liveDatabaseClaims?: number
  },
  runStep: StepRunner = kernelRunStep,
  runUndo: StepRunner = kernelRunUndo,
): { removed: boolean; detail: string } {
  const stored = input.stored ?? readSnapshot(input.runId)
  if (!stored.snapshot) {
    const liveDatabases = input.liveDatabaseClaims ?? liveDatabaseClaims(input.runId)
    if (snapshotlessTeardown(liveDatabases) === 'keep') {
      return {
        removed: false,
        detail: `tracked recipe tree has no recorded recipe snapshot and ${liveDatabases} live database claim(s); kept`,
      }
    }
    const removal = input.remove()
    return removal.removed
      ? {
          ...removal,
          detail: `${removal.detail}; no recorded recipe snapshot, removed as a plain tree`,
        }
      : removal
  }
  const treeExists = input.treeExists ?? existsSync(input.worktree.path)
  const { results, stopFailure, stopNote } = runTrackedTeardown({
    runId: input.runId,
    worktree: input.worktree,
    stored: { ...stored, snapshot: stored.snapshot },
    treeExists,
    runStep,
    runUndo,
  })
  const failure = trackedTeardownFailure(results, stopFailure, stopNote)
  if (failure) return { removed: false, detail: failure }
  settleTrackedTeardown(input.runId)
  const removal = input.remove()
  return stopNote ? { ...removal, detail: `${removal.detail}; ${stopNote}` } : removal
}
