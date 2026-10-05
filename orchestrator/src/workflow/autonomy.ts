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
import { readStoredShipTo, SHIP_TO_VALUES, type ShipToValue } from '../../../shared/ship-to.ts'

export const autonomyStages = AUTONOMY_STAGES
export const autonomyValues = AUTONOMY_VALUES
export const autonomyPresets = AUTONOMY_PRESETS
export const builtInAutonomyPreset: AutonomyPreset = 'guided'
const builtInShipTo: ShipToValue = 'trunk'

export type { AutonomyPreset, AutonomyStage, AutonomyValue }
export type StageAutonomyValue = AutonomyValue | 'per step'
export type ShipTo = ShipToValue
type CatalogueStep = { slug: string; stage?: AutonomyStage; autonomy: AutonomyValue }
type WorkflowAutonomySettings = {
  preset?: AutonomyPreset
  stages?: Partial<Record<AutonomyStage, AutonomyValue>>
  steps?: Record<string, AutonomyValue>
  rulings?: 'agent' | 'user'
}
export type AutonomySettings = WorkflowAutonomySettings & {
  shipTo?: ShipTo
  workflows?: Record<string, WorkflowAutonomySettings>
}
export type StoredAutonomySettings = Omit<AutonomySettings, 'shipTo'> & {
  'ship-to'?: unknown
  release?: unknown
}
export type WrittenAutonomySettings = Omit<AutonomySettings, 'shipTo'> & {
  'ship-to'?: ShipTo
}
export type AutonomyResolution = {
  steps: Record<string, { value: AutonomyValue; scope: string }>
  stages?: Partial<Record<AutonomyStage, { value: StageAutonomyValue; scope: string }>>
  rulings: RulingsResolution
  shipTo: {
    value: ShipTo
    scope: string
    complete?: boolean
    unavailableReason?: string
  }
  hosted?: {
    status: 'available' | 'not-configured' | 'unavailable'
    reason?: string
    user?: AutonomySettings
    space?: AutonomySettings
  }
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
  const shipTo = value.shipTo
  if (shipTo !== undefined && !allowed(shipTo, SHIP_TO_VALUES))
    throw new Error(
      `invalid autonomy setting at ${scope} key ship-to: ${String(shipTo)}; expected one of ${SHIP_TO_VALUES.join(', ')}`,
    )
  return {
    ...settings,
    ...(shipTo === undefined ? {} : { shipTo: shipTo as ShipTo }),
    ...validateWorkflows(value.workflows, scope),
  }
}

export function validateStoredAutonomySettings(
  value: unknown,
  scope: string,
): { settings: AutonomySettings; ignoredShipTo?: unknown } {
  if (object(value)) {
    if (Object.hasOwn(value, 'shipTo')) return { settings: validateAutonomySettings(value, scope) }
    const hasShipTo = Object.hasOwn(value, 'ship-to')
    const hasRelease = Object.hasOwn(value, 'release')
    const read = readStoredShipTo(value['ship-to'], value.release, hasShipTo, hasRelease)
    const { release: _release, 'ship-to': _shipTo, ...rest } = value
    const settings = validateAutonomySettings(
      read.level === undefined ? rest : { ...rest, shipTo: read.level },
      scope,
    )
    return {
      settings,
      ...(read.invalid === undefined ? {} : { ignoredShipTo: read.invalid }),
    }
  }
  return { settings: validateAutonomySettings(value, scope) }
}

function ignoredShipToWarning(scope: string, value: unknown): string {
  return `warning: ignored invalid autonomy setting at ${scope} key ship-to: ${String(value)}; expected one of ${SHIP_TO_VALUES.join(', ')}`
}

export function autonomySettingsForStorage(
  settings: AutonomySettings | StoredAutonomySettings,
): WrittenAutonomySettings {
  const validated = validateStoredAutonomySettings(settings, 'stored autonomy').settings
  const { shipTo, ...rest } = validated
  return { ...rest, ...(shipTo === undefined ? {} : { 'ship-to': shipTo }) }
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
    const { settings, ignoredShipTo } = validateStoredAutonomySettings(scope.settings, scope.name)
    if (ignoredShipTo !== undefined) {
      warnings.push(ignoredShipToWarning(scope.name, ignoredShipTo))
    }
    return { name: scope.name, settings }
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
  const shipTo = checked
    .map((scope) => ({ name: scope.name, value: scope.settings.shipTo }))
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
    shipTo: shipTo
      ? { value: shipTo.value!, scope: shipTo.name }
      : { value: builtInShipTo, scope: 'built-in' },
    ...(warnings.length ? { warnings } : {}),
  }
}

export const catalogueStepsForAutonomy = (
  steps: Pick<CatalogueStep, 'slug' | 'stage' | 'autonomy'>[],
): Pick<CatalogueStep, 'slug' | 'stage' | 'autonomy'>[] =>
  steps.map(({ slug, stage, autonomy }) => ({ slug, stage, autonomy }))

export const builtInAutonomyScope = (defaultPreset?: AutonomyPreset) => ({
  name: 'built-in',
  settings: { preset: defaultPreset ?? builtInAutonomyPreset, shipTo: builtInShipTo },
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

function parseAutonomyInput(text: string | undefined, source: string): Record<string, unknown> {
  if (!text?.trim()) return {}
  const result: AutonomySettings & { 'ship-to'?: string; release?: string } = {}
  for (const item of text.split(',')) {
    const at = item.indexOf('=')
    if (at < 1) throw new Error(`invalid ${source} autonomy ${JSON.stringify(item)}; use key=value`)
    const key = item.slice(0, at).trim()
    const value = item.slice(at + 1).trim()
    if (key === 'preset' || key === 'rulings') (result as Record<string, unknown>)[key] = value
    else if (key === 'ship-to' || key === 'release') result[key] = value
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
  const parsed = parseAutonomyInput(text, source)
  const read = readStoredShipTo(
    parsed['ship-to'],
    parsed.release,
    Object.hasOwn(parsed, 'ship-to'),
    Object.hasOwn(parsed, 'release'),
  )
  if (read.invalid !== undefined)
    throw new Error(
      `invalid autonomy setting at ${source} key ship-to: ${String(read.invalid)}; expected one of ${SHIP_TO_VALUES.join(', ')}`,
    )
  const { release: _release, 'ship-to': _shipTo, ...rest } = parsed
  return validateAutonomySettings(
    read.level === undefined ? rest : { ...rest, shipTo: read.level },
    source,
  )
}

/** Stored settings are validated scope-by-scope so one bad ship-to value can be ignored. */
export function parseStoredAutonomy(
  text: string | undefined,
  source: string,
): { settings: AutonomySettings; warning?: string } {
  const parsed = parseAutonomyInput(text, source)
  const validated = validateStoredAutonomySettings(parsed, source)
  return {
    settings: validated.settings,
    ...(validated.ignoredShipTo === undefined
      ? {}
      : { warning: ignoredShipToWarning(source, validated.ignoredShipTo) }),
  }
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
