// concern: tracked recipe environment-file writing
/** Writes validated env declarations atomically without exposing their contents in failures. */
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { connectionUrlForAllocatedDatabase, readConnectionValue } from './database-connection.ts'
import { managedBlockPlan, omitKeys } from './env-file.ts'
import type { TrackedRecipe } from './recipe-schema.ts'
import type { StepContext, StepResult } from './recipe-step.ts'

type EnvTextPlan = { ok: true; text: string } | { ok: false; reason: string }
type Allocation = NonNullable<NonNullable<TrackedRecipe['allocate']>['databases']>[string]
const ENV_PLACEHOLDER = /\{([^{}]+)\}/g
const DATABASE_URL_PLACEHOLDER = /^db\.([^{}.]+)\.url$/
const DATABASE_URL_ENGINES = new Set(['postgres', 'mysql', 'mariadb'])

function fillEnvContents(contents: string, vars: Record<string, string>): EnvTextPlan {
  for (const match of contents.matchAll(ENV_PLACEHOLDER)) {
    if (!(match[1]! in vars)) return { ok: false, reason: `unavailable placeholder {${match[1]}}` }
  }
  return {
    ok: true,
    text: contents.replace(ENV_PLACEHOLDER, (_placeholder, name: string) => vars[name]!),
  }
}

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
        : 'could not read existing target',
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

function provisionedUrlAllocation(allocation: Allocation | undefined): Allocation | undefined {
  if (!allocation?.provision || !DATABASE_URL_ENGINES.has(allocation.engine)) return undefined
  return allocation
}

function urlPlaceholderTarget(
  placeholder: string,
  recipe: TrackedRecipe,
  allocations: Record<string, string>,
): { key: string; allocation: Allocation; allocatedName: string } | null {
  const key = placeholder.match(DATABASE_URL_PLACEHOLDER)?.[1]
  if (!key) return null
  const allocation = provisionedUrlAllocation(recipe.allocate?.databases?.[key])
  const allocatedName = allocations[key]
  if (!allocation || !allocatedName) return null
  return { key, allocation, allocatedName }
}

function allocatedDatabaseUrl(
  key: string,
  allocation: Allocation,
  allocatedName: string,
  projectRoot: string,
): { ok: true; value: string } | { ok: false; detail: string } {
  const connection = {
    key: allocation.provision!.connection.key,
    file: allocation.provision!.connection.file ?? '.env',
  }
  const resolved = readConnectionValue(projectRoot, connection)
  if (!resolved.ok) return { ok: false, detail: `database "${key}" ${resolved.detail}` }
  try {
    return { ok: true, value: connectionUrlForAllocatedDatabase(resolved.value, allocatedName) }
  } catch (error) {
    return {
      ok: false,
      detail: `database "${key}" connection key ${connection.key} in ${connection.file} is unusable: ${String((error as Error)?.message ?? error)}`,
    }
  }
}

export function databaseUrlSecrets(
  recipe: TrackedRecipe,
  allocations: Record<string, string>,
  projectRoot: string,
): { ok: true; secrets: Record<string, string> } | { ok: false; result: StepResult } {
  const secrets: Record<string, string> = {}
  for (const envFile of recipe.env ?? []) {
    for (const match of envFile.contents.matchAll(ENV_PLACEHOLDER)) {
      const placeholder = match[1]!
      if (placeholder in secrets) continue
      const target = urlPlaceholderTarget(placeholder, recipe, allocations)
      if (!target) continue
      const resolved = allocatedDatabaseUrl(
        target.key,
        target.allocation,
        target.allocatedName,
        projectRoot,
      )
      if (!resolved.ok) return { ok: false, result: envFileFailure(envFile.path, resolved.detail) }
      secrets[placeholder] = resolved.value
    }
  }
  return { ok: true, secrets }
}

export function writeTrackedEnvFiles(
  recipe: TrackedRecipe,
  context: StepContext,
  projectRoot: string,
  secrets: Record<string, string> = {},
): StepResult | null {
  const envFiles = recipe.env ?? []
  const filledContents: string[] = []
  const vars = { ...context.vars, ...secrets }
  for (const envFile of envFiles) {
    const filled = fillEnvContents(envFile.contents, vars)
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
