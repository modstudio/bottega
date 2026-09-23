// concern: tracked recipe execution
/** Executes validated tracked lifecycle plans and records the immutable recipe used by a tree. */

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { git, gitOk } from '../git/git-environment.ts'
import type { WorktreeTool } from '../project/projects.ts'
import { orchRunLabel } from '../resources/docker-resources.ts'
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
import { resolveBase } from '../worktree/worktree-caller.ts'
import { provisionWorktree } from '../worktree/worktree-provision.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { managedBlockPlan, omitKeys } from './env-file.ts'
import {
  compensationPlan,
  destroyPlan,
  lifecycleFailure,
  serveUndoPlan,
  sharedDeclarations,
  snapshotlessTeardown,
  teardownVars,
} from './recipe-lifecycle.ts'
import { parseTrackedRecipe } from './recipe-loader.ts'
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

export type RecipeSnapshot = {
  source: { path: string; commit: string }
  recipe: TrackedRecipe
  allocations?: RecipeAllocations
}
export type RecipeAllocations = {
  index: number
  ports: Record<string, number>
  databases: Record<string, string>
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

const ENV_PLACEHOLDER = /\{([^{}]+)\}/g

function fillEnvContents(contents: string, vars: Record<string, string>): EnvTextPlan {
  for (const match of contents.matchAll(ENV_PLACEHOLDER)) {
    if (!(match[1]! in vars)) {
      return { ok: false, reason: `unavailable placeholder {${match[1]}}` }
    }
  }
  return {
    ok: true,
    text: contents.replace(ENV_PLACEHOLDER, (_placeholder, name: string) => vars[name]!),
  }
}

type EnvTextPlan = { ok: true; text: string } | { ok: false; reason: string }

function readEnvBase(
  envFile: NonNullable<TrackedRecipe['env']>[number],
  treeRoot: string,
  projectRoot: string,
): EnvTextPlan {
  const inherited = envFile.inherit !== undefined
  const source = inherited ? join(projectRoot, envFile.inherit!) : join(treeRoot, envFile.path)
  if (!existsSync(source)) {
    return inherited
      ? { ok: false, reason: `could not read inherited path "${envFile.inherit}"` }
      : { ok: true, text: '' }
  }
  try {
    const text = readFileSync(source, 'utf8')
    return { ok: true, text: inherited ? omitKeys(text, envFile.omit ?? []) : text }
  } catch {
    return {
      ok: false,
      reason: inherited
        ? `could not read inherited path "${envFile.inherit}"`
        : `could not read existing target`,
    }
  }
}

function atomicEnvWrite(target: string, text: string): void {
  const existingMode = existsSync(target) ? statSync(target).mode & 0o7777 : 0o600
  const temporary = join(dirname(target), `.${basename(target)}.orch-${randomUUID()}`)
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, text, 'utf8')
    closeSync(descriptor)
    descriptor = null
    chmodSync(temporary, existingMode)
    renameSync(temporary, target)
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor)
    try {
      unlinkSync(temporary)
    } catch {}
    throw error
  }
}

/** Write declared env files in order without exposing their contents in failures. */
export function writeTrackedEnvFiles(
  recipe: TrackedRecipe,
  context: StepContext,
  projectRoot: string,
): StepResult | null {
  const envFiles = recipe.env ?? []
  const filledContents: string[] = []
  for (const envFile of envFiles) {
    const filled = fillEnvContents(envFile.contents, context.vars)
    if (!filled.ok) return envFileFailure(envFile.path, filled.reason)
    filledContents.push(filled.text)
  }
  for (const [index, envFile] of envFiles.entries()) {
    const base = readEnvBase(envFile, context.treeRoot, projectRoot)
    if (!base.ok) return envFileFailure(envFile.path, base.reason)
    const contents = filledContents[index]!
    const mode = envFile.mode ?? 'managed-block'
    const plan =
      mode === 'replace'
        ? { ok: true as const, text: contents }
        : mode === 'append'
          ? { ok: true as const, text: `${base.text}${contents}` }
          : managedBlockPlan(base.text, basename(context.treeRoot), contents)
    if (!plan.ok) return envFileFailure(envFile.path, plan.reason)
    try {
      atomicEnvWrite(join(context.treeRoot, envFile.path), plan.text)
    } catch {
      return envFileFailure(envFile.path, 'atomic write failed')
    }
  }
  return null
}

function envFileFailure(path: string, detail: string): StepResult {
  return {
    name: `env ${path}`,
    phase: 'run',
    status: 'refused',
    exitCode: null,
    argv: null,
    detail: `env file "${path}" refused: ${detail}`,
    durationMs: 0,
  }
}

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
             WHERE id>? AND root_run_id=? AND run_id=? AND kind IN ('port','index','string','database')
             ORDER BY id`,
          )
          .all(before, owner.root_run_id, input.runId) as { id: number }[]
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

function loadRecipeAtBase(input: { tool: WorktreeTool; repoRoot: string; baseRef?: string }): {
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
    return loaded.recipe ?? { create: [] }
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

/** Read the same tracked config used by creation and decide its hook branch. */
export function trackedHookBranch(input: {
  tool: WorktreeTool
  repoRoot: string
  baseRef?: string
  name: string
}): string {
  const { recipe } = loadRecipeAtBase(input)
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
    const loaded = loadRecipeAtBase({ tool, repoRoot })
    return renderTrackedRecipeNotes(loaded.recipe, repoRoot)
  } catch {
    return ''
  }
}

export function recipeAllocationEnvironment(
  allocations: RecipeAllocations | undefined,
  rootRunId?: number,
): Record<string, string> {
  const environment: Record<string, string> = {}
  if (rootRunId !== undefined) environment.ORCH_RUN_LABEL = orchRunLabel(rootRunId)
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
  rootRunId: number,
): Record<string, string> {
  const vars: Record<string, string> = {
    ...staticVars,
    index: String(allocations.index),
    label: orchRunLabel(rootRunId),
    tree_exists: 'true',
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

export function trackedRecipeEnvironment(runId: number): Record<string, string> {
  const stored = readSnapshot(runId)
  return recipeAllocationEnvironment(stored.snapshot?.allocations, stored.rootRunId)
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

function writeSnapshot(runId: number, snapshot: RecipeSnapshot): void {
  db()
    .query(
      `UPDATE run SET recipe_snapshot=? WHERE id=(SELECT COALESCE(parent_run_id,id) FROM run WHERE id=?)`,
    )
    .run(JSON.stringify(snapshot), runId)
}

function recordedRecipe(recipe: TrackedRecipe): TrackedRecipe {
  const recorded = { ...recipe }
  delete recorded.env
  return recorded
}

function liveDatabaseClaims(runId: number): number {
  return (
    db()
      .query(
        `SELECT COUNT(*) count FROM resource_claim
         WHERE root_run_id=(SELECT COALESCE(parent_run_id,id) FROM run WHERE id=?)
           AND kind='database' AND state='claimed'`,
      )
      .get(runId) as { count: number }
  ).count
}

export function readSnapshot(runId: number): {
  snapshot: RecipeSnapshot | null
  key: string | null
  seed: string | null
  rootRunId: number
} {
  const row = db()
    .query(
      `SELECT id root_run_id,recipe_snapshot snapshot,launch_key key,launch_seed seed FROM run
       WHERE id=(SELECT COALESCE(parent_run_id,id) FROM run WHERE id=?)`,
    )
    .get(runId) as {
    root_run_id: number
    snapshot: string | null
    key: string | null
    seed: string | null
  } | null
  return {
    snapshot: row?.snapshot ? (JSON.parse(row.snapshot) as RecipeSnapshot) : null,
    key: row?.key ?? null,
    seed: row?.seed ?? null,
    rootRunId: row?.root_run_id ?? runId,
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
  const vars = trackedRecipeVars(staticVars, allocations, readSnapshot(input.runId).rootRunId)
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
    const skipped = provisionWorktree(input.repoRoot, path, prepared.recipe.provision ?? [])
    for (const entry of skipped) {
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
  const envFailure = writeTrackedEnvFiles(prepared.recipe, context, input.repoRoot)
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
    stored?: {
      snapshot: RecipeSnapshot | null
      key: string | null
      seed: string | null
      rootRunId?: number
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
  const vars = teardownVars({
    path: input.worktree.path,
    branch: input.worktree.branch,
    base: stored.snapshot.source.commit,
    key: stored.key,
    seed: stored.seed,
    main: input.worktree.repoRoot,
    label: orchRunLabel(stored.rootRunId ?? readSnapshot(input.runId).rootRunId),
    treeExists,
    allocations: stored.snapshot.allocations,
  })
  const temporaryCwd = treeExists ? null : mkdtempSync(join(tmpdir(), 'orch-teardown-'))
  const context = { treeRoot: temporaryCwd ?? input.worktree.path, vars }
  let results: StepResult[]
  try {
    results = serveUndoPlan(stored.snapshot.recipe).map((step) => runUndo(step, context))
    for (const { step, phase } of destroyPlan(stored.snapshot.recipe))
      results.push(phase === 'run' ? runStep(step, context) : runUndo(step, context))
    for (const step of stored.snapshot.recipe.verifyDown ?? []) results.push(runStep(step, context))
  } finally {
    if (temporaryCwd) rmSync(temporaryCwd, { recursive: true, force: true })
  }
  const failed = lifecycleFailure(results)
  if (failed) {
    return {
      removed: false,
      detail: `recipe teardown failed at "${failed.name}" (${failed.phase}): ${failed.detail}`,
    }
  }
  writeTransaction(() => {
    const owner = db()
      .query('SELECT COALESCE(parent_run_id,id) root_run_id FROM run WHERE id=?')
      .get(input.runId) as { root_run_id: number } | null
    if (owner) {
      settleClaims(db(), {
        rootRunId: owner.root_run_id,
        kind: 'database',
        state: 'released',
        settledAt: nowIso(),
        detail: 'tracked recipe teardown completed',
      })
    }
  })
  return input.remove()
}
