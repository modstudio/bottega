// concern: workflows
/** Owns the pure workflow-autonomy vocabulary, parsing, resolution, and decisions. */

import type { CatalogueStep } from './step-catalogue.ts'

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
  rulings: RulingsResolution
  note?: string
  session?: AutonomySettings
}
export type RulingsResolution = {
  value: 'agent' | 'user'
  scope: string
  complete?: boolean
  unavailableReason?: string
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
  step: Pick<CatalogueStep, 'slug' | 'stage' | 'autonomy'>,
  settings: AutonomySettings,
): AutonomyValue | undefined {
  const explicit =
    settings.steps?.[step.slug] ?? (step.stage ? settings.stages?.[step.stage] : undefined)
  if (explicit) return explicit
  if (settings.preset === 'manual') return 'ask'
  if (settings.preset === 'autonomous') return 'auto'
  if (settings.preset === 'guided') return step.autonomy
  return undefined
}

export function resolveAutonomy(
  steps: Pick<CatalogueStep, 'slug' | 'stage' | 'autonomy'>[],
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
    resolved[step.slug] ??= { value: step.autonomy, scope: 'built-in' }
  }
  const ruling = checked.find(
    (scope) => scope.settings.rulings !== undefined || scope.settings.preset !== undefined,
  )
  const presetRuling = (preset: AutonomySettings['preset']): 'agent' | 'user' =>
    preset === 'manual' ? 'user' : 'agent'
  return {
    steps: resolved,
    rulings: ruling
      ? {
          value: ruling.settings.rulings ?? presetRuling(ruling.settings.preset),
          scope: ruling.name,
        }
      : { value: 'agent', scope: 'built-in' },
  }
}

export const catalogueStepsForAutonomy = (
  steps: Pick<CatalogueStep, 'slug' | 'stage' | 'autonomy'>[],
): Pick<CatalogueStep, 'slug' | 'stage' | 'autonomy'>[] =>
  steps.map(({ slug, stage, autonomy }) => ({ slug, stage, autonomy }))

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

export function answerRulingRefusal(
  ruling: RulingsResolution,
  fromOperator: boolean,
): string | null {
  if (!fromOperator && ruling.complete === false)
    return (
      `rulings could not be resolved: hosted autonomy settings unavailable (${ruling.unavailableReason}); ` +
      'answer with --from-operator, or set rulings in machine.toml or the project register'
    )
  return ruling.value === 'user' && !fromOperator
    ? `rulings is user (${ruling.scope}): relay this question to the operator and answer with --from-operator`
    : null
}
