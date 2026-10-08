import type { Database } from 'bun:sqlite'
import { db, writableDb } from '../database/db.ts'
import { projects } from '../project/projects.ts'
import {
  type AutonomyPreset,
  type AutonomyResolution,
  autonomyPresets,
  builtInAutonomyScope,
  catalogueStepsForAutonomy,
  resolveAutonomy,
} from './autonomy.ts'
import {
  compatibleCatalogueStep,
  productionStepCatalogue,
  type StepCatalogueDefinition,
  showStepCatalogue,
} from './step-catalogue.ts'
import { type VersionEvent, versionedLifecycle } from './versioned-lifecycle.ts'
import type { WorkflowDefinition, WorkflowMode, WorkflowModeStep } from './workflow-definition.ts'
import {
  resolveWorkflowProjectFacts,
  stepNeedsCloseState,
  workflowCompositionFactExtras,
} from './workflow-project-facts.ts'
import { checkWorkflowRendering, renderCheckRefusal } from './workflow-render-check.ts'
import type { WorkflowModeStepList } from './workflow-step-reference.ts'
import {
  expandWorkflowSteps,
  inspectWorkflowSteps,
  isSequenceReference,
  workflowModeStepError,
} from './workflow-step-sequences.ts'
import {
  resolveWorkflowStepExpectedStatus,
  resolveWorkflowStepFloors,
  resolveWorkflowStepTemplates,
  resolveWorkflowTemplate,
} from './workflow-template.ts'

export type { WorkflowDefinition } from './workflow-definition.ts'

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const WORKFLOW_PROMPT_ARGUMENT_NAMES = new Set(['mode', 'project', 'autonomy'])
const workflowPromptArgumentNameErrors = (name: unknown): string[] =>
  typeof name === 'string' && WORKFLOW_PROMPT_ARGUMENT_NAMES.has(name)
    ? [`argument name "${name}" is reserved for the workflow prompt`]
    : []

const workflowDefaultPresetErrors = (preset: unknown): string[] =>
  preset === undefined ||
  (typeof preset === 'string' && autonomyPresets.includes(preset as AutonomyPreset))
    ? []
    : ['defaultPreset must be manual, guided, or autonomous']

function workflowArgumentErrors(argument: unknown, index: number): string[] {
  if (!object(argument)) return [`argument ${index + 1} must be an object`]
  const name = text(argument.name)
  return [
    ...(typeof argument.name === 'string'
      ? workflowPromptArgumentNameErrors(argument.name)
      : [`argument ${index + 1} name must be a string`]),
    ...(typeof argument.required === 'boolean'
      ? []
      : [`argument "${name}" required must be a boolean`]),
    ...(typeof argument.description === 'string'
      ? []
      : [`argument "${name}" description must be a string`]),
    ...(argument.rebind === undefined || typeof argument.rebind === 'boolean'
      ? []
      : [`argument "${name}" rebind must be a boolean`]),
    ...(argument.name === 'key' && argument.rebind !== undefined
      ? ['argument "key" cannot declare rebind']
      : []),
  ]
}

function workflowModeRequirementErrors(mode: Record<string, unknown>, args: unknown[]): string[] {
  if (mode.requires === undefined) return []
  if (!Array.isArray(mode.requires) || mode.requires.some((name) => typeof name !== 'string'))
    return [`mode "${text(mode.slug)}" requires must be a string array`]
  const argumentNames = new Set(
    args.flatMap((argument) =>
      object(argument) && typeof argument.name === 'string' ? [argument.name] : [],
    ),
  )
  return mode.requires.flatMap((name) =>
    argumentNames.has(name)
      ? []
      : [`mode "${text(mode.slug)}" requires undeclared argument "${name}"`],
  )
}

function workflowCatalogue(
  d: Database | undefined,
  knownCatalogue: StepCatalogueDefinition | undefined,
  errors: string[],
): StepCatalogueDefinition | null {
  if (knownCatalogue) return knownCatalogue
  if (!d) return null
  try {
    return productionStepCatalogue(d).definition
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
    return null
  }
}

function workflowModeReferenceErrors(
  mode: Record<string, unknown>,
  catalogue: StepCatalogueDefinition | null,
): string[] {
  const slug = text(mode.slug)
  if (!Array.isArray(mode.steps) || mode.steps.length === 0)
    return [`mode "${slug}" must contain at least one step`]
  if (!catalogue) return []
  const entries = mode.steps.filter(
    (entry): entry is WorkflowModeStep => typeof entry === 'string' || isSequenceReference(entry),
  )
  const stepNames = new Set(catalogue.steps.map((step) => step.slug))
  const inspection = inspectWorkflowSteps(entries, catalogue.sequences ?? [], stepNames)
  if (inspection.missingSequences.length)
    return [
      `mode "${slug}" sequence "${inspection.missingSequences[0]}" is absent from the catalogue; add and promote that sequence, or edit the workflow mode to remove the reference`,
    ]
  const missing = inspection.missingSteps.map(
    (ref) =>
      `mode "${slug}" references missing step "${ref}"; add and promote that catalogue step, or edit the workflow mode`,
  )
  return inspection.duplicateSteps.length
    ? [
        ...missing,
        `mode "${slug}" expands to duplicate step ${inspection.duplicateSteps.map((ref) => `"${ref}"`).join(', ')}; edit its step and sequence references so each step appears once`,
      ]
    : missing
}

export function validateWorkflowDefinition(
  value: unknown,
  d?: Database,
  knownCatalogue?: StepCatalogueDefinition,
): string[] {
  const errors: string[] = []
  if (!object(value)) return ['definition must be an object']
  if (typeof value.title !== 'string') errors.push('title must be a string')
  else if (!value.title.trim()) errors.push('title must be non-empty')
  if (typeof value.description !== 'string') errors.push('description must be a string')
  errors.push(...workflowDefaultPresetErrors(value.defaultPreset))
  const args = Array.isArray(value.arguments) ? value.arguments : []
  const modes = Array.isArray(value.modes) ? value.modes : []
  if (!Array.isArray(value.arguments)) errors.push('arguments must be an array')
  if (!Array.isArray(value.modes)) errors.push('modes must be an array')
  if ('steps' in value) errors.push('steps belongs in the shared step catalogue')

  for (const [index, argument] of args.entries())
    errors.push(...workflowArgumentErrors(argument, index))
  for (const [index, mode] of modes.entries()) {
    if (!object(mode)) {
      errors.push(`mode ${index + 1} must be an object`)
      continue
    }
    if (typeof mode.slug !== 'string') errors.push(`mode ${index + 1} slug must be a string`)
    if (typeof mode.title !== 'string')
      errors.push(`mode "${text(mode.slug)}" title must be a string`)
    if (mode.default !== undefined && typeof mode.default !== 'boolean')
      errors.push(`mode "${text(mode.slug)}" default must be a boolean`)
    if (mode.entry !== undefined && typeof mode.entry !== 'string')
      errors.push(`mode "${text(mode.slug)}" entry must be a string`)
    errors.push(...workflowModeRequirementErrors(mode, args))
    if (!Array.isArray(mode.steps)) errors.push(`mode "${text(mode.slug)}" steps must be an array`)
    else
      for (const entry of mode.steps) {
        const error = workflowModeStepError(entry)
        if (error) errors.push(`mode "${text(mode.slug)}" ${error}`)
      }
  }

  const checkSlugs = (items: unknown[], kind: string) => {
    const seen = new Set<string>()
    for (const item of items) {
      const slug = object(item) ? text(item.slug) : ''
      if (!SLUG.test(slug)) errors.push(`${kind} slug "${slug}" is not well-formed`)
      if (seen.has(slug)) errors.push(`duplicate ${kind} slug "${slug}"`)
      seen.add(slug)
    }
  }
  checkSlugs(
    args.map((arg) => (object(arg) ? { slug: arg.name } : arg)),
    'argument',
  )
  checkSlugs(modes, 'mode')

  const defaults = modes.filter((mode) => object(mode) && mode.default === true)
  if (defaults.length > 1) errors.push('exactly one default mode is allowed')
  if (defaults.length === 0) {
    for (const mode of modes) {
      if (!object(mode) || !text(mode.entry).trim()) {
        errors.push(
          `mode "${object(mode) ? text(mode.slug) : ''}" needs an entry question when there is no default`,
        )
      }
    }
  } else {
    for (const mode of modes) {
      if (object(mode) && text(mode.entry).trim()) {
        errors.push(
          `mode "${text(mode.slug)}" has an unreachable entry question beside a default mode`,
        )
      }
    }
  }

  const catalogue = workflowCatalogue(d, knownCatalogue, errors)
  for (const mode of modes) {
    if (!object(mode)) continue
    errors.push(...workflowModeReferenceErrors(mode, catalogue))
  }
  return [...new Set(errors)]
}

function requireValid(
  value: unknown,
  d?: Database,
  knownCatalogue?: StepCatalogueDefinition,
): asserts value is WorkflowDefinition {
  const errors = validateWorkflowDefinition(value, d, knownCatalogue)
  if (errors.length)
    throw new Error(`invalid workflow definition:\n${errors.map((e) => `- ${e}`).join('\n')}`)
}

function catalogueReferenceRefusal(
  workflowSlug: string,
  definition: WorkflowDefinition,
  catalogue: StepCatalogueDefinition,
  selectedMode?: string,
): string | null {
  const catalogueSlugs = new Set(catalogue.steps.map((step) => step.slug))
  const missing: { slug: string; steps: string[] }[] = []
  for (const mode of definition.modes.filter(
    (mode) => selectedMode === undefined || mode.slug === selectedMode,
  )) {
    const inspection = inspectWorkflowSteps(mode.steps, catalogue.sequences ?? [], catalogueSlugs)
    if (inspection.missingSequences.length)
      return `workflow "${workflowSlug}" mode "${mode.slug}" sequence "${inspection.missingSequences[0]}" is absent from the catalogue; add and promote that sequence, or edit the workflow mode to remove the reference`
    if (inspection.duplicateSteps.length)
      return `workflow "${workflowSlug}" mode "${mode.slug}" expands to duplicate step ${inspection.duplicateSteps.map((step) => `"${step}"`).join(', ')}; edit its step and sequence references so each step appears once`
    if (inspection.missingSteps.length)
      missing.push({ slug: mode.slug, steps: inspection.missingSteps })
  }
  if (!missing.length) return null
  return [
    `workflow "${workflowSlug}" names steps absent from the production catalogue:`,
    ...missing.map(
      (mode) => `- mode "${mode.slug}": ${mode.steps.map((step) => `"${step}"`).join(', ')}`,
    ),
    'fix: promote a catalogue step with that slug, or set the workflow to a mode that does not use it',
  ].join('\n')
}
function requireSlug(slug: string): void {
  if (!SLUG.test(slug))
    throw new Error(
      'invalid slug; use 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit',
    )
}
function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

type VersionRow = {
  id: number
  workflow_id: number
  slug: string
  n: number
  status: 'draft' | 'production' | 'retired'
  definition: string
  author: string
  reason: string
  created_at: string
  promoted_at: string | null
  retired_at: string | null
}
function versionRow(slug: string, n?: number, d: Database = db()): VersionRow {
  // Unqualified show prefers production, then the newest draft, then the
  // newest retired. A newer draft must not shadow live production.
  const where =
    n === undefined
      ? `ORDER BY CASE status WHEN 'production' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, n DESC LIMIT 1`
      : `AND v.n=?`
  const row = d
    .query(
      `SELECT v.*, w.slug FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? ${where}`,
    )
    .get(...(n === undefined ? [slug] : [slug, n])) as VersionRow | null
  if (!row)
    throw new Error(
      n === undefined ? `unknown workflow "${slug}"` : `workflow "${slug}" has no version ${n}`,
    )
  return row
}
const parseVersion = (row: VersionRow) => ({
  ...row,
  definition: JSON.parse(row.definition) as WorkflowDefinition,
})

function productionVersionRow(slug: string, d: Database = db()): VersionRow {
  const row = d
    .query(`SELECT v.*, w.slug FROM workflow_version v
    JOIN workflow w ON w.id=v.workflow_id
    WHERE w.slug=? AND v.status='production'`)
    .get(slug) as VersionRow | null
  if (!row) throw new Error(`workflow "${slug}" has no production version; promote one`)
  return row
}

export function listWorkflows(d: Database = db()) {
  const rows = d
    .query(`SELECT w.id,w.slug,
    (SELECT n FROM workflow_version WHERE workflow_id=w.id AND status='production') production_n,
    (SELECT MAX(n) FROM workflow_version WHERE workflow_id=w.id AND status='draft') draft_n
    FROM workflow w ORDER BY w.slug`)
    .all() as { id: number; slug: string; production_n: number | null; draft_n: number | null }[]
  return rows.map((row) => {
    const selected = versionRow(row.slug, row.production_n ?? row.draft_n ?? undefined, d)
    return {
      slug: row.slug,
      title: (JSON.parse(selected.definition) as WorkflowDefinition).title,
      production_n: row.production_n,
      draft_n: row.draft_n,
    }
  })
}

export function productionWorkflows(
  d: Database = db(),
): { slug: string; definition: WorkflowDefinition }[] {
  return (
    d
      .query(
        `SELECT w.slug,v.definition FROM workflow w JOIN workflow_version v ON v.workflow_id=w.id
         WHERE v.status='production' ORDER BY w.slug`,
      )
      .all() as { slug: string; definition: string }[]
  ).map((row) => ({ slug: row.slug, definition: JSON.parse(row.definition) as WorkflowDefinition }))
}
export function showWorkflow(slug: string, n?: number, d: Database = db()) {
  return parseVersion(versionRow(slug, n, d))
}

const workflowLifecycleFor = (knownCatalogue?: StepCatalogueDefinition) =>
  versionedLifecycle<WorkflowDefinition>({
    noun: 'workflow',
    identityTable: 'workflow',
    versionTable: 'workflow_version',
    eventTable: 'workflow_event',
    foreignKey: 'workflow_id',
    validate(value, d) {
      requireValid(value, d, knownCatalogue)
    },
  })
const workflowLifecycle = workflowLifecycleFor()
function writeDraft(
  slug: string,
  definition: unknown,
  reasonValue: string | undefined,
  authorValue?: string,
  kind: Extract<VersionEvent, 'set' | 'fork' | 'import'> = 'set',
  d: Database = writableDb(),
  knownCatalogue?: StepCatalogueDefinition,
) {
  requireSlug(slug)
  requireSlug(slug)
  return (knownCatalogue ? workflowLifecycleFor(knownCatalogue) : workflowLifecycle).write(
    slug,
    definition,
    reasonValue,
    authorValue,
    kind,
    d,
  )
}
export const setWorkflow = (
  slug: string,
  definition: unknown,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) => writeDraft(slug, definition, reason, author, 'set', d)

export function promoteWorkflow(
  slug: string,
  n: number,
  reasonValue: string | undefined,
  authorValue?: string,
  d: Database = writableDb(),
) {
  // A draft is validated against the catalogue it was written for; the
  // production catalogue may have dropped one of its steps since.
  return workflowLifecycle.promote(slug, n, reasonValue, authorValue, d, (definition, database) => {
    requireValid(definition)
    const catalogue = productionStepCatalogue(database).definition,
      refusal = catalogueReferenceRefusal(slug, definition, catalogue)
    if (refusal) throw new Error(refusal)
    const workflows = productionWorkflows(database).filter((workflow) => workflow.slug !== slug)
    workflows.push({ slug, definition })
    const renderRefusal = renderCheckRefusal(
      checkWorkflowRendering(
        workflows,
        productionStepCatalogue(database).definition,
        projects(undefined, database),
      ),
    )
    if (renderRefusal) throw new Error(renderRefusal)
  })
}
export function retireWorkflow(
  slug: string,
  n: number,
  reasonValue: string | undefined,
  authorValue?: string,
  d: Database = writableDb(),
) {
  return workflowLifecycle.retire(slug, n, reasonValue, authorValue, d)
}
export function forkWorkflow(
  slug: string,
  from: number | undefined,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) {
  const definition = (
    from === undefined
      ? workflowLifecycle.production(slug, d)
      : workflowLifecycle.show(slug, from, d)
  ).definition
  return writeDraft(slug, definition, reason, author, 'fork', d)
}
export function workflowVersions(slug: string, d: Database = db()) {
  return workflowLifecycle.versions(slug, d)
}

type WorkflowNeeds = {
  mode?: { slug: string; title: string; entry: string }[]
  arguments?: { name: string; description: string }[]
}
type WorkflowSelection = { version?: number; catalogueVersion?: number; mode?: string }

const selectedWorkflow = (slug: string, version: number | undefined, d: Database) =>
  version === undefined
    ? parseVersion(productionVersionRow(slug, d))
    : showWorkflow(slug, version, d)
const selectedCatalogue = (version: number | undefined, d: Database) =>
  version === undefined ? productionStepCatalogue(d) : showStepCatalogue(version, d)

export function resolveWorkflowMode(
  definition: WorkflowDefinition,
  modeSlug?: string,
): WorkflowMode | undefined {
  return modeSlug
    ? definition.modes.find((mode) => mode.slug === modeSlug)
    : definition.modes.find((mode) => mode.default)
}

export function workflowModeStepLists(
  slug: string,
  d: Database = db(),
  selection: WorkflowSelection = {},
): WorkflowModeStepList[] {
  const workflow = selectedWorkflow(slug, selection.version, d)
  const catalogue = selectedCatalogue(selection.catalogueVersion, d)
  return workflow.definition.modes.map((mode) => ({
    mode: mode.slug,
    steps: expandWorkflowSteps(mode.steps, catalogue.definition.sequences ?? []),
  }))
}

function missingWorkflowArguments(
  definition: WorkflowDefinition,
  modes: WorkflowMode[],
  args: Record<string, string>,
): { name: string; description: string }[] {
  const required = new Set([
    ...definition.arguments
      .filter((argument) => argument.required)
      .map((argument) => argument.name),
    ...modes.flatMap((mode) => mode.requires ?? []),
  ])
  return definition.arguments
    .filter((argument) => required.has(argument.name) && !args[argument.name]?.trim())
    .map(({ name, description }) => ({ name, description }))
}

export function composeWorkflow(
  slug: string,
  projectName: string,
  modeSlug?: string,
  args: Record<string, string> = {},
  d: Database = db(),
  selection: WorkflowSelection = {},
  autonomy?: AutonomyResolution,
) {
  const row = selectedWorkflow(slug, selection.version, d),
    definition = row.definition,
    catalogue = selectedCatalogue(selection.catalogueVersion, d)
  const mode = resolveWorkflowMode(definition, modeSlug)
  const needs: WorkflowNeeds = {}
  if (modeSlug && !mode) throw new Error(`workflow "${slug}" has no mode "${modeSlug}"`)
  if (!mode)
    needs.mode = definition.modes.map(({ slug, title, entry }) => ({ slug, title, entry: entry! }))
  const refusal = mode
    ? catalogueReferenceRefusal(slug, definition, catalogue.definition, mode.slug)
    : null
  if (refusal) throw new Error(refusal)
  const missing = missingWorkflowArguments(definition, mode ? [mode] : [], args)
  if (missing.length) needs.arguments = missing
  const projectRow = d
    .query('SELECT name,stack,settings FROM project WHERE name=? AND retired_at IS NULL')
    .get(projectName) as { name: string; stack: string | null; settings: string | null } | null
  if (!projectRow) throw new Error(`unknown project "${projectName}"`)
  const project = {
    name: projectRow.name,
    stack: projectRow.stack,
    settings: JSON.parse(projectRow.settings ?? '{}'),
  }
  const selectedSlugs = mode
    ? expandWorkflowSteps(mode.steps, catalogue.definition.sequences ?? [])
    : []
  const selected = selectedSlugs.map((stepSlug) =>
    compatibleCatalogueStep(catalogue.definition.steps.find((step) => step.slug === stepSlug)!),
  )
  const effectiveAutonomy =
    autonomy ??
    resolveAutonomy(
      catalogueStepsForAutonomy(selected),
      [builtInAutonomyScope(definition.defaultPreset)],
      slug,
    )
  const allNeeds = selected.flatMap((step) => step.needs)
  const { resolved, facts } = resolveWorkflowProjectFacts(
    project,
    allNeeds,
    selected.some((step) => stepNeedsCloseState(step.needs)),
    args,
    effectiveAutonomy,
    workflowCompositionFactExtras,
  )
  const values: Record<string, unknown> = { project: projectName, ...args, ...facts }
  return {
    workflow: {
      slug,
      title: definition.title,
      description: definition.description,
      defaultPreset: definition.defaultPreset,
      version: row.n,
    },
    project: projectName,
    catalogue: { version: catalogue.n },
    mode: mode ? { slug: mode.slug, title: mode.title } : null,
    declaredArguments: definition.arguments,
    arguments: args,
    steps:
      selected.map((step, index) => {
        const resolve = (template: string) => resolveWorkflowTemplate(template, values)
        return {
          n: index + 1,
          slug: step.slug,
          title: step.title,
          job: step.job,
          stage: step.stage,
          autonomy: step.autonomy,
          resolvedAutonomy: effectiveAutonomy.steps[step.slug]!,
          floor: resolveWorkflowStepFloors(step, resolve),
          deferrable: step.deferrable ?? [],
          expectedStatus: resolveWorkflowStepExpectedStatus(step, resolve),
          requirePullRequest: Boolean(step.requirePullRequest),
          operatorRuling: Boolean(step.operatorRuling),
          commandEvidence: step.commandEvidence,
          needs: step.needs,
        }
      }) ?? [],
    docs: {
      global: { scope: 'global' as const },
      stack: { scope: 'stack' as const, subject: resolved.stack },
      project: resolved.docs,
    },
    facts,
    needs,
    rulings: effectiveAutonomy.rulings,
    autonomyNote: autonomy?.note,
  }
}

function workflowModesForStep(
  definition: WorkflowDefinition,
  sequences: StepCatalogueDefinition['sequences'],
  selectedModeSlug: string | undefined,
  stepSlug: string,
) {
  const expandedModes = definition.modes.map((mode) => ({
    mode,
    steps: expandWorkflowSteps(mode.steps, sequences ?? []),
  }))
  const selectedMode = selectedModeSlug
    ? expandedModes.find(({ mode }) => mode.slug === selectedModeSlug)
    : undefined
  const containingModes = expandedModes.filter(({ steps }) => steps.includes(stepSlug))
  return {
    selectedMode,
    containingModes,
    referenced: selectedMode ? selectedMode.steps.includes(stepSlug) : containingModes.length > 0,
  }
}

export function getWorkflowStep(
  slug: string,
  projectName: string,
  stepSlug: string,
  args: Record<string, string> = {},
  d: Database = db(),
  selection: WorkflowSelection = {},
  autonomy?: AutonomyResolution,
) {
  const row = selectedWorkflow(slug, selection.version, d),
    definition = row.definition,
    catalogue = selectedCatalogue(selection.catalogueVersion, d),
    { selectedMode, containingModes, referenced } = workflowModesForStep(
      definition,
      catalogue.definition.sequences,
      selection.mode,
      stepSlug,
    ),
    rawStep = catalogue.definition.steps.find((item) => item.slug === stepSlug),
    step = rawStep ? compatibleCatalogueStep(rawStep) : undefined
  if (selection.mode && !selectedMode)
    throw new Error(`workflow "${slug}" has no mode "${selection.mode}"`)
  if (!referenced || !step) throw new Error(`workflow "${slug}" has no step "${stepSlug}"`)
  const missing = missingWorkflowArguments(
    definition,
    selectedMode ? [selectedMode.mode] : containingModes.map(({ mode }) => mode),
    args,
  )
  if (missing.length)
    throw new Error(`missing required arguments: ${missing.map(({ name }) => name).join(', ')}`)
  const projectRow = d
    .query('SELECT name,stack,settings FROM project WHERE name=? AND retired_at IS NULL')
    .get(projectName) as { name: string; stack: string | null; settings: string | null } | null
  if (!projectRow) throw new Error(`unknown project "${projectName}"`)
  const project = {
    name: projectRow.name,
    stack: projectRow.stack,
    settings: JSON.parse(projectRow.settings ?? '{}'),
  }
  const effectiveAutonomy =
    autonomy ??
    resolveAutonomy(
      catalogueStepsForAutonomy([step]),
      [builtInAutonomyScope(definition.defaultPreset)],
      slug,
    )
  const { facts } = resolveWorkflowProjectFacts(
    project,
    step.needs,
    stepNeedsCloseState(step.needs),
    args,
    effectiveAutonomy,
  )
  const values: Record<string, unknown> = { project: projectName, ...args, ...facts }
  const resolve = (template: string) =>
    resolveWorkflowTemplate(template, values, {
      argumentNames: new Set(definition.arguments.map(({ name }) => name)),
      project: project.name,
      key: args.key,
    })
  const templates = resolveWorkflowStepTemplates(step, resolve)
  const successor = ({ steps }: { steps: string[] }) => {
    const index = steps.indexOf(stepSlug)
    if (index === steps.length - 1) return null
    const next = catalogue.definition.steps.find((item) => item.slug === steps[index + 1])!
    return { n: index + 2, slug: next.slug, title: next.title }
  }
  const successorModes = selectedMode ? [selectedMode] : containingModes
  const successors = successorModes.map(successor)
  const next = selectedMode
    ? successors[0]
    : successors.every((candidate) => JSON.stringify(candidate) === JSON.stringify(successors[0]))
      ? successors[0]
      : undefined
  return {
    ...step,
    floor: templates.floor,
    expectedStatus: templates.expectedStatus,
    commandEvidence: step.commandEvidence,
    resolvedAutonomy: effectiveAutonomy.steps[step.slug]!,
    workflow: slug,
    version: row.n,
    catalogueVersion: catalogue.n,
    project: projectName,
    mode: selectedMode?.mode.slug,
    facts,
    body: templates.body,
    next,
  }
}

export function importWorkflow(
  slug: string,
  definition: unknown,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
  knownCatalogue?: StepCatalogueDefinition,
) {
  required(reason, 'reason')
  return writeDraft(slug, definition, reason, author, 'import', d, knownCatalogue)
}
