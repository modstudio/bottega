// concern: workflows
/** Owns pure workflow-autonomy resolution and gathers its ordered scopes. */

import type { Database } from 'bun:sqlite'
import type { ConfigClient } from '../../../shared/config-client.ts'
import { configClient } from '../../../shared/config-client.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import { readMachineAutonomy } from '../../../shared/machine-config.ts'
import { db } from '../database/db.ts'

export const autonomyStages = ['plan', 'implement', 'review', 'docs', 'canon', 'ship'] as const
export const autonomyValues = ['ask', 'review', 'auto'] as const
export type AutonomyStage = (typeof autonomyStages)[number]
export type AutonomyValue = (typeof autonomyValues)[number]
export type AutonomySettings = {
  preset?: 'manual' | 'guided' | 'autonomous'
  stages?: Partial<Record<AutonomyStage, AutonomyValue>>
  steps?: Record<string, AutonomyValue>
  rulings?: 'agent' | 'user'
}
export type AutonomyResolution = {
  steps: Record<string, { value: AutonomyValue; scope: string }>
  rulings: { value: 'agent' | 'user'; scope: string }
  note?: string
  session?: AutonomySettings
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const allowed = (value: unknown, values: readonly string[]) =>
  typeof value === 'string' && values.includes(value)

function validatePreset(value: unknown, scope: string): Pick<AutonomySettings, 'preset'> {
  if (value === undefined) return {}
  if (!allowed(value, ['manual', 'guided', 'autonomous']))
    throw new Error(`invalid autonomy setting at ${scope} key preset: ${String(value)}`)
  return { preset: value as AutonomySettings['preset'] }
}

function validateRulings(value: unknown, scope: string): Pick<AutonomySettings, 'rulings'> {
  if (value === undefined) return {}
  if (!allowed(value, ['agent', 'user']))
    throw new Error(`invalid autonomy setting at ${scope} key rulings: ${String(value)}`)
  return { rulings: value as 'agent' | 'user' }
}

function validateStages(value: unknown, scope: string): Pick<AutonomySettings, 'stages'> {
  if (value === undefined) return {}
  if (!object(value))
    throw new Error(`invalid autonomy setting at ${scope} key stages: expected an object`)
  const stages: NonNullable<AutonomySettings['stages']> = {}
  for (const [key, setting] of Object.entries(value)) {
    if (!allowed(key, autonomyStages))
      throw new Error(`invalid autonomy setting at ${scope} key stages.${key}: unknown stage`)
    if (!allowed(setting, autonomyValues))
      throw new Error(`invalid autonomy setting at ${scope} key stages.${key}: ${String(setting)}`)
    stages[key as AutonomyStage] = setting as AutonomyValue
  }
  return { stages }
}

function validateSteps(value: unknown, scope: string): Pick<AutonomySettings, 'steps'> {
  if (value === undefined) return {}
  if (!object(value))
    throw new Error(`invalid autonomy setting at ${scope} key steps: expected an object`)
  const steps: NonNullable<AutonomySettings['steps']> = {}
  for (const [key, setting] of Object.entries(value)) {
    if (!allowed(setting, autonomyValues))
      throw new Error(`invalid autonomy setting at ${scope} key steps.${key}: ${String(setting)}`)
    steps[key] = setting as AutonomyValue
  }
  return { steps }
}

export function validateAutonomySettings(value: unknown, scope: string): AutonomySettings {
  if (value === undefined) return {}
  if (!object(value)) throw new Error(`invalid autonomy setting at ${scope}: expected an object`)
  return {
    ...validatePreset(value.preset, scope),
    ...validateRulings(value.rulings, scope),
    ...validateStages(value.stages, scope),
    ...validateSteps(value.steps, scope),
  }
}

function resolvedStepValue(
  step: { slug: string; stage?: AutonomyStage; default: AutonomyValue },
  settings: AutonomySettings,
): AutonomyValue | undefined {
  const explicit =
    settings.steps?.[step.slug] ?? (step.stage ? settings.stages?.[step.stage] : undefined)
  if (explicit) return explicit
  if (settings.preset === 'manual') return 'ask'
  if (settings.preset === 'autonomous') return 'auto'
  if (settings.preset === 'guided') return step.default
  return undefined
}

export function resolveAutonomy(
  steps: { slug: string; stage?: AutonomyStage; default: AutonomyValue }[],
  scopes: { name: string; settings: unknown }[],
): AutonomyResolution {
  const checked = scopes.map((scope) => ({
    name: scope.name,
    settings: validateAutonomySettings(scope.settings, scope.name),
  }))
  const resolved: AutonomyResolution['steps'] = {}
  for (const step of steps) {
    for (const scope of checked) {
      const value = resolvedStepValue(step, scope.settings)
      if (value) {
        resolved[step.slug] = { value, scope: scope.name }
        break
      }
    }
    resolved[step.slug] ??= { value: step.default, scope: 'built-in' }
  }
  const ruling = checked.find((scope) => scope.settings.rulings !== undefined)
  return {
    steps: resolved,
    rulings: ruling
      ? { value: ruling.settings.rulings!, scope: ruling.name }
      : { value: 'agent', scope: 'built-in' },
  }
}

export function parseAutonomy(text: string | undefined, source: string): AutonomySettings {
  if (!text?.trim()) return {}
  const result: AutonomySettings = {}
  for (const item of text.split(',')) {
    const at = item.indexOf('=')
    if (at < 1) throw new Error(`invalid ${source} autonomy ${JSON.stringify(item)}; use key=value`)
    const key = item.slice(0, at).trim()
    const value = item.slice(at + 1).trim()
    if (key === 'preset' || key === 'rulings') (result as Record<string, unknown>)[key] = value
    else if (key.startsWith('stage.')) {
      result.stages ??= {}
      result.stages[key.slice(6) as AutonomyStage] = value as AutonomyValue
    } else if (key.startsWith('step.')) {
      result.steps ??= {}
      result.steps[key.slice(5)] = value as AutonomyValue
    } else throw new Error(`invalid ${source} autonomy key ${JSON.stringify(key)}`)
  }
  return validateAutonomySettings(result, source)
}

export const HOSTED_AUTONOMY_TIMEOUT_MS = 2000
export function answerRulingRefusal(
  ruling: AutonomyResolution['rulings'],
  fromOperator: boolean,
): string | null {
  return ruling.value === 'user' && !fromOperator
    ? `rulings is user (${ruling.scope}): relay this question to the operator and answer with --from-operator`
    : null
}
type HostedEntry = Awaited<ReturnType<ConfigClient['listEntries']>>[number]
const hostedSettings = (rows: HostedEntry[], scope: 'user' | 'space') =>
  parseAutonomy(
    rows
      .filter((row) => row.scope === scope && row.key.startsWith('autonomy.'))
      .map((row) => `${row.key.slice(9)}=${row.value}`)
      .join(','),
    `hosted ${scope}`,
  )

export async function resolveProjectAutonomy(
  project: string,
  steps: { slug: string; stage?: AutonomyStage; default: AutonomyValue }[] = [],
  session: AutonomySettings = {},
  clientFactory: (signal: AbortSignal) => ConfigClient = (signal) =>
    configClient(process.env, fetch, undefined, signal),
  d: Database = db(),
  env: ConfigEnvironment = process.env,
  timeoutMs: number = HOSTED_AUTONOMY_TIMEOUT_MS,
): Promise<AutonomyResolution> {
  const row = d
    .query('SELECT settings FROM project WHERE name=? AND retired_at IS NULL')
    .get(project) as { settings: string } | null
  if (!row) throw new Error(`unknown project "${project}"`)
  const registered = JSON.parse(row.settings || '{}') as { autonomy?: unknown }
  const local = readMachineAutonomy(project, env)
  let user: AutonomySettings = {},
    space: AutonomySettings = {},
    note: string | undefined
  try {
    const signal = AbortSignal.timeout(timeoutMs)
    const rows = await clientFactory(signal).listEntries()
    user = hostedSettings(rows, 'user')
    space = hostedSettings(rows, 'space')
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === 'TimeoutError'
        ? `timed out after ${timeoutMs} ms`
        : error instanceof Error
          ? error.message
          : String(error)
    note = `hosted autonomy settings unavailable: ${reason}; resolved from local and project scopes`
  }
  const resolution = resolveAutonomy(steps, [
    { name: 'session', settings: session },
    { name: 'local project', settings: local.project },
    { name: 'project', settings: registered.autonomy },
    { name: 'local user', settings: local.user },
    { name: 'hosted user', settings: user },
    { name: 'hosted space', settings: space },
    { name: 'built-in', settings: { preset: 'guided' } },
  ])
  return { ...resolution, note, session }
}
