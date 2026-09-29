// concern: workflows
/** Owns the pure workflow-autonomy vocabulary, parsing, resolution, and decisions. */

import {
  AUTONOMY_PRESETS,
  AUTONOMY_STAGES,
  AUTONOMY_VALUES,
  type AutonomyPreset,
  type AutonomyStage,
  type AutonomyValue,
} from '../../../shared/autonomy.ts'
import {
  RELEASE_AUTONOMY_VALUES,
  type ReleaseAutonomyValue,
} from '../../../shared/release-autonomy.ts'

export const autonomyStages = AUTONOMY_STAGES
export const autonomyValues = AUTONOMY_VALUES
export const autonomyPresets = AUTONOMY_PRESETS
export const builtInAutonomyPreset: AutonomyPreset = 'guided'
const builtInRelease: ReleaseValue = 'land'

export type { AutonomyPreset, AutonomyStage, AutonomyValue }
export type StageAutonomyValue = AutonomyValue | 'per step'
export type ReleaseValue = ReleaseAutonomyValue
type CatalogueStep = { slug: string; stage?: AutonomyStage; autonomy: AutonomyValue }
type WorkflowAutonomySettings = {
  preset?: AutonomyPreset
  stages?: Partial<Record<AutonomyStage, AutonomyValue>>
  steps?: Record<string, AutonomyValue>
  rulings?: 'agent' | 'user'
}
export type AutonomySettings = WorkflowAutonomySettings & {
  release?: ReleaseValue
  workflows?: Record<string, WorkflowAutonomySettings>
}
export type AutonomyResolution = {
  steps: Record<string, { value: AutonomyValue; scope: string }>
  stages?: Partial<Record<AutonomyStage, { value: StageAutonomyValue; scope: string }>>
  rulings: RulingsResolution
  release: { value: ReleaseValue; scope: string }
  hosted?: { status: 'available' | 'not-configured' | 'unavailable'; reason?: string }
  note?: string
  warnings?: string[]
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

function validatePreset(
  value: unknown,
  scope: string,
  key = 'preset',
): Pick<WorkflowAutonomySettings, 'preset'> {
  if (value === undefined) return {}
  if (!allowed(value, autonomyPresets))
    throw new Error(`invalid autonomy setting at ${scope} key ${key}: ${String(value)}`)
  return { preset: value as AutonomySettings['preset'] }
}

function validateRulings(
  value: unknown,
  scope: string,
  key = 'rulings',
): Pick<WorkflowAutonomySettings, 'rulings'> {
  if (value === undefined) return {}
  if (!allowed(value, ['agent', 'user']))
    throw new Error(`invalid autonomy setting at ${scope} key ${key}: ${String(value)}`)
  return { rulings: value as 'agent' | 'user' }
}

function validateStages(
  value: unknown,
  scope: string,
  key = 'stages',
): Pick<WorkflowAutonomySettings, 'stages'> {
  if (value === undefined) return {}
  if (!object(value))
    throw new Error(`invalid autonomy setting at ${scope} key ${key}: expected an object`)
  const stages: NonNullable<AutonomySettings['stages']> = {}
  for (const [stage, setting] of Object.entries(value)) {
    if (!allowed(stage, autonomyStages))
      throw new Error(`invalid autonomy setting at ${scope} key ${key}.${stage}: unknown stage`)
    if (!allowed(setting, autonomyValues))
      throw new Error(
        `invalid autonomy setting at ${scope} key ${key}.${stage}: ${String(setting)}`,
      )
    stages[stage as AutonomyStage] = setting as AutonomyValue
  }
  return { stages }
}

function validateSteps(
  value: unknown,
  scope: string,
  key = 'steps',
): Pick<WorkflowAutonomySettings, 'steps'> {
  if (value === undefined) return {}
  if (!object(value))
    throw new Error(`invalid autonomy setting at ${scope} key ${key}: expected an object`)
  const steps: NonNullable<AutonomySettings['steps']> = {}
  for (const [step, setting] of Object.entries(value)) {
    if (!allowed(setting, autonomyValues))
      throw new Error(`invalid autonomy setting at ${scope} key ${key}.${step}: ${String(setting)}`)
    steps[step] = setting as AutonomyValue
  }
  return { steps }
}

function validateWorkflowSettings(
  value: unknown,
  scope: string,
  prefix = '',
): WorkflowAutonomySettings {
  if (value === undefined) return {}
  if (!object(value))
    throw new Error(
      `invalid autonomy setting at ${scope}${prefix ? ` key ${prefix.slice(0, -1)}` : ''}: expected an object`,
    )
  return {
    ...validatePreset(value.preset, scope, `${prefix}preset`),
    ...validateRulings(value.rulings, scope, `${prefix}rulings`),
    ...validateStages(value.stages, scope, `${prefix}stages`),
    ...validateSteps(value.steps, scope, `${prefix}steps`),
  }
}

function validateWorkflows(value: unknown, scope: string): Pick<AutonomySettings, 'workflows'> {
  if (value === undefined) return {}
  if (!object(value))
    throw new Error(`invalid autonomy setting at ${scope} key workflows: expected an object`)
  const workflows: NonNullable<AutonomySettings['workflows']> = {}
  for (const [slug, settings] of Object.entries(value)) {
    workflows[slug] = validateWorkflowSettings(settings, scope, `workflows.${slug}.`)
  }
  return { workflows }
}

export function validateAutonomySettings(value: unknown, scope: string): AutonomySettings {
  const settings = validateWorkflowSettings(value, scope)
  if (!object(value)) return settings
  if (value.release !== undefined && !allowed(value.release, RELEASE_AUTONOMY_VALUES))
    throw new Error(
      `invalid autonomy setting at ${scope} key release: ${String(value.release)}; expected one of ${RELEASE_AUTONOMY_VALUES.join(', ')}`,
    )
  return {
    ...settings,
    ...(value.release === undefined ? {} : { release: value.release as ReleaseValue }),
    ...validateWorkflows(value.workflows, scope),
  }
}

function resolvedAutonomyValue(
  subject: Pick<CatalogueStep, 'stage'> & { slug?: string; autonomy?: AutonomyValue },
  settings: WorkflowAutonomySettings,
): StageAutonomyValue | undefined {
  const explicit =
    (subject.slug ? settings.steps?.[subject.slug] : undefined) ??
    (subject.stage ? settings.stages?.[subject.stage] : undefined)
  if (explicit) return explicit
  if (settings.preset === 'manual') return 'ask'
  if (settings.preset === 'autonomous') return 'auto'
  if (settings.preset === 'guided') return subject.autonomy ?? 'per step'
  return undefined
}

function resolveSubject(
  subject: Pick<CatalogueStep, 'stage' | 'autonomy'> & { slug?: string },
  scopes: { name: string; settings: AutonomySettings }[],
  workflow?: string,
): { value: AutonomyValue; scope: string }
function resolveSubject(
  subject: Pick<CatalogueStep, 'stage'> & { autonomy?: undefined; slug?: string },
  scopes: { name: string; settings: AutonomySettings }[],
  workflow?: string,
): { value: StageAutonomyValue; scope: string }
function resolveSubject(
  subject: Pick<CatalogueStep, 'stage'> & { slug?: string; autonomy?: AutonomyValue },
  scopes: { name: string; settings: AutonomySettings }[],
  workflow?: string,
): { value: StageAutonomyValue; scope: string } {
  for (const scope of scopes) {
    const value =
      (workflow && resolvedAutonomyValue(subject, scope.settings.workflows?.[workflow] ?? {})) ||
      resolvedAutonomyValue(subject, scope.settings)
    if (value) return { value, scope: scope.name }
  }
  return { value: subject.autonomy ?? 'per step', scope: 'built-in' }
}

export function resolveAutonomy(
  steps: Pick<CatalogueStep, 'slug' | 'stage' | 'autonomy'>[],
  scopes: { name: string; settings: unknown }[],
  workflow?: string,
  stages: readonly AutonomyStage[] = [],
): AutonomyResolution {
  const warnings: string[] = []
  const checked = scopes.map((scope) => {
    if (
      object(scope.settings) &&
      scope.settings.release !== undefined &&
      !allowed(scope.settings.release, RELEASE_AUTONOMY_VALUES)
    ) {
      const { release, ...rest } = scope.settings
      const settings = validateAutonomySettings(rest, scope.name)
      warnings.push(
        `warning: ignored invalid autonomy setting at ${scope.name} key release: ${String(release)}; expected one of ${RELEASE_AUTONOMY_VALUES.join(', ')}`,
      )
      return { name: scope.name, settings }
    }
    return { name: scope.name, settings: validateAutonomySettings(scope.settings, scope.name) }
  })
  const resolved: AutonomyResolution['steps'] = {}
  for (const step of steps) {
    resolved[step.slug] = resolveSubject(step, checked, workflow)
  }
  const resolvedStages = Object.fromEntries(
    stages.map((stage) => [stage, resolveSubject({ stage }, checked, workflow)]),
  ) as AutonomyResolution['stages']
  const presetRuling = (preset: AutonomySettings['preset']): 'agent' | 'user' =>
    preset === 'manual' ? 'user' : 'agent'
  const resolvedRuling = (settings: WorkflowAutonomySettings): 'agent' | 'user' | undefined =>
    settings.rulings ?? (settings.preset === undefined ? undefined : presetRuling(settings.preset))
  const ruling = checked
    .map((scope) => ({
      name: scope.name,
      value:
        (workflow && resolvedRuling(scope.settings.workflows?.[workflow] ?? {})) ||
        resolvedRuling(scope.settings),
    }))
    .find(({ value }) => value !== undefined)
  const release = checked
    .map((scope) => ({ name: scope.name, value: scope.settings.release }))
    .find(({ value }) => value !== undefined)
  return {
    steps: resolved,
    ...(stages.length ? { stages: resolvedStages } : {}),
    rulings: ruling
      ? {
          value: ruling.value!,
          scope: ruling.name,
        }
      : { value: 'agent', scope: 'built-in' },
    release: release
      ? { value: release.value!, scope: release.name }
      : { value: builtInRelease, scope: 'built-in' },
    ...(warnings.length ? { warnings } : {}),
  }
}

export const catalogueStepsForAutonomy = (
  steps: Pick<CatalogueStep, 'slug' | 'stage' | 'autonomy'>[],
): Pick<CatalogueStep, 'slug' | 'stage' | 'autonomy'>[] =>
  steps.map(({ slug, stage, autonomy }) => ({ slug, stage, autonomy }))

export const builtInAutonomyScope = (defaultPreset?: AutonomyPreset) => ({
  name: 'built-in',
  settings: { preset: defaultPreset ?? builtInAutonomyPreset, release: builtInRelease },
})

export function combineRulingsSnapshots(snapshots: RulingsResolution[]): RulingsResolution | null {
  if (!snapshots.length) return null
  return (
    snapshots.find(({ complete }) => complete === false) ??
    snapshots.find(({ value }) => value === 'user') ??
    snapshots[0]!
  )
}

function parseWorkflowAutonomySetting(
  result: AutonomySettings,
  key: string,
  value: string,
  source: string,
): boolean {
  if (!key.startsWith('workflow.')) return false
  const [prefix, slug, kind, name, ...extra] = key.split('.')
  if (
    prefix !== 'workflow' ||
    !slug ||
    extra.length ||
    !(
      (name === undefined && (kind === 'preset' || kind === 'rulings')) ||
      (name !== undefined && (kind === 'stage' || kind === 'step'))
    )
  )
    throw new Error(`invalid ${source} autonomy key ${JSON.stringify(key)}`)
  result.workflows ??= {}
  result.workflows[slug] ??= {}
  const workflow = result.workflows[slug]
  if (kind === 'preset' || kind === 'rulings') (workflow as Record<string, unknown>)[kind] = value
  else if (kind === 'stage') {
    workflow.stages ??= {}
    workflow.stages[name as AutonomyStage] = value as AutonomyValue
  } else {
    workflow.steps ??= {}
    workflow.steps[name!] = value as AutonomyValue
  }
  return true
}

function parseAutonomyInput(text: string | undefined, source: string): AutonomySettings {
  if (!text?.trim()) return {}
  const result: AutonomySettings = {}
  for (const item of text.split(',')) {
    const at = item.indexOf('=')
    if (at < 1) throw new Error(`invalid ${source} autonomy ${JSON.stringify(item)}; use key=value`)
    const key = item.slice(0, at).trim()
    const value = item.slice(at + 1).trim()
    if (key === 'preset' || key === 'rulings' || key === 'release')
      (result as Record<string, unknown>)[key] = value
    else if (key.startsWith('stage.')) {
      result.stages ??= {}
      result.stages[key.slice(6) as AutonomyStage] = value as AutonomyValue
    } else if (key.startsWith('step.')) {
      result.steps ??= {}
      result.steps[key.slice(5)] = value as AutonomyValue
    } else if (!parseWorkflowAutonomySetting(result, key, value, source))
      throw new Error(`invalid ${source} autonomy key ${JSON.stringify(key)}`)
  }
  return result
}

export function parseAutonomy(text: string | undefined, source: string): AutonomySettings {
  return validateAutonomySettings(parseAutonomyInput(text, source), source)
}

/** Stored settings are validated scope-by-scope so one bad release value can be ignored. */
export function parseStoredAutonomy(text: string | undefined, source: string): AutonomySettings {
  return parseAutonomyInput(text, source)
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
