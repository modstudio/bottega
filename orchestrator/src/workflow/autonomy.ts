// concern: workflows
/** Owns the pure workflow-autonomy vocabulary, parsing, resolution, and decisions. */

export const autonomyStages = ['plan', 'implement', 'review', 'docs', 'canon', 'ship'] as const
export const autonomyValues = ['ask', 'review', 'auto'] as const
export type AutonomyStage = (typeof autonomyStages)[number]
export type AutonomyValue = (typeof autonomyValues)[number]
type CatalogueStep = { slug: string; stage?: AutonomyStage; autonomy: AutonomyValue }
export type WorkflowAutonomySettings = {
  preset?: 'manual' | 'guided' | 'autonomous'
  stages?: Partial<Record<AutonomyStage, AutonomyValue>>
  steps?: Record<string, AutonomyValue>
  rulings?: 'agent' | 'user'
}
export type AutonomySettings = WorkflowAutonomySettings & {
  workflows?: Record<string, WorkflowAutonomySettings>
}
export type AutonomyResolution = {
  steps: Record<string, { value: AutonomyValue; scope: string }>
  rulings: RulingsResolution
  hosted?: { status: 'available' | 'not-configured' | 'unavailable'; reason?: string }
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

function validatePreset(
  value: unknown,
  scope: string,
  key = 'preset',
): Pick<WorkflowAutonomySettings, 'preset'> {
  if (value === undefined) return {}
  if (!allowed(value, ['manual', 'guided', 'autonomous']))
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
  return object(value) ? { ...settings, ...validateWorkflows(value.workflows, scope) } : settings
}

function resolvedStepValue(
  step: Pick<CatalogueStep, 'slug' | 'stage' | 'autonomy'>,
  settings: WorkflowAutonomySettings,
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
  workflow?: string,
): AutonomyResolution {
  const checked = scopes.map((scope) => ({
    name: scope.name,
    settings: validateAutonomySettings(scope.settings, scope.name),
  }))
  const resolved: AutonomyResolution['steps'] = {}
  for (const step of steps) {
    for (const scope of checked) {
      const value =
        (workflow && resolvedStepValue(step, scope.settings.workflows?.[workflow] ?? {})) ||
        resolvedStepValue(step, scope.settings)
      if (value) {
        resolved[step.slug] = { value, scope: scope.name }
        break
      }
    }
    resolved[step.slug] ??= { value: step.autonomy, scope: 'built-in' }
  }
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
  return {
    steps: resolved,
    rulings: ruling
      ? {
          value: ruling.value!,
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
    } else if (key.startsWith('workflow.')) {
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
      const workflow = (result.workflows[slug] ??= {})
      if (kind === 'preset' || kind === 'rulings')
        (workflow as Record<string, unknown>)[kind] = value
      else if (kind === 'stage') {
        workflow.stages ??= {}
        workflow.stages[name as AutonomyStage] = value as AutonomyValue
      } else {
        workflow.steps ??= {}
        workflow.steps[name!] = value as AutonomyValue
      }
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
