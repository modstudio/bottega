import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, sessionId, writableDb } from '../database/db.ts'
import { projects } from '../project/projects.ts'
import { effectiveProjectSpace } from '../project-space.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import { applyWorkflowWriteResponse } from '../record/record-cache-workflow.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import { workerStoreWriteRefusal } from '../worker-store-write.ts'
import {
  type AutonomyPreset,
  autonomyPresets,
  builtInAutonomyScope,
  catalogueStepsForAutonomy,
  resolveAutonomy,
  type WorkflowAutonomyResolution,
} from './autonomy.ts'
import {
  compatibleCatalogueStep,
  productionStepCatalogue,
  type StepCatalogueDefinition,
  selectedStepCatalogue,
} from './step-catalogue.ts'
import { type VersionEvent, versionedLifecycle } from './versioned-lifecycle.ts'
import type { WorkflowDefinition, WorkflowMode, WorkflowModeStep } from './workflow-definition.ts'
import {
  resolveWorkflowProjectFacts,
  stepNeedsCloseState,
  workflowCompositionFactExtras,
} from './workflow-project-facts.ts'
import { checkWorkflowRendering, renderCheckRefusal } from './workflow-render-check.ts'
import {
  projectCatalogueResolutionSpace,
  projectWorkflowResolutionSpace,
} from './workflow-resolution-space.ts'
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
function assertWorkflowWriteAllowed(operation: string): void {
  const refusal = workerStoreWriteRefusal('workflow', operation, process.env)
  if (refusal) throw new Error(refusal)
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
function versionRow(
  slug: string,
  n?: number,
  d: Database = db(),
  spaceId: string | null = null,
): VersionRow {
  // Unqualified show prefers production, then the newest draft, then the
  // newest retired. A newer draft must not shadow live production.
  const where =
    n === undefined
      ? `ORDER BY CASE status WHEN 'production' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, n DESC LIMIT 1`
      : `AND v.n=?`
  const row = d
    .query(
      `SELECT v.*, w.slug FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? AND w.space_id IS ? ${where}`,
    )
    .get(...(n === undefined ? [slug, spaceId] : [slug, spaceId, n])) as VersionRow | null
  if (!row)
    throw new Error(
      `${n === undefined ? `unknown workflow "${slug}"` : `workflow "${slug}" has no version ${n}`}${spaceId === null ? '' : ` in hosted space ${spaceId}`}`,
    )
  return row
}
const parseVersion = (row: VersionRow) => ({
  ...row,
  definition: JSON.parse(row.definition) as WorkflowDefinition,
})

function productionVersionRow(
  slug: string,
  d: Database = db(),
  spaceId: string | null = null,
): VersionRow {
  const row = d
    .query(`SELECT v.*, w.slug FROM workflow_version v
    JOIN workflow w ON w.id=v.workflow_id
    WHERE w.slug=? AND w.space_id IS ? AND v.status='production'`)
    .get(slug, spaceId) as VersionRow | null
  if (!row)
    throw new Error(
      `workflow "${slug}" has no production version${spaceId === null ? '' : ` in hosted space ${spaceId}`}; promote one`,
    )
  return row
}

export function listWorkflows(d: Database = db()) {
  return listResolvedWorkflows(null, d)
}

function workflowSlugs(d: Database, spaceId: string | null = null): string[] {
  return (
    d.query('SELECT slug FROM workflow WHERE space_id IS ? ORDER BY slug').all(spaceId) as {
      slug: string
    }[]
  ).map(({ slug }) => slug)
}

export function listResolvedWorkflows(project: string | null, d: Database = db()) {
  const spaceId = projectCatalogueResolutionSpace(d, project)
  return workflowSlugs(d, spaceId).flatMap((slug) => {
    const row = d
      .query(`SELECT w.id,w.slug,
    (SELECT n FROM workflow_version WHERE workflow_id=w.id AND status='production') production_n,
    (SELECT MAX(n) FROM workflow_version WHERE workflow_id=w.id AND status='draft') draft_n
    FROM workflow w WHERE w.slug=? AND w.space_id IS ?`)
      .get(slug, spaceId) as {
      id: number
      slug: string
      production_n: number | null
      draft_n: number | null
    } | null
    if (!row) return []
    const selected = versionRow(row.slug, row.production_n ?? row.draft_n ?? undefined, d, spaceId)
    return [
      {
        slug: row.slug,
        title: (JSON.parse(selected.definition) as WorkflowDefinition).title,
        production_n: row.production_n,
        draft_n: row.draft_n,
      },
    ]
  })
}

export function productionWorkflows(
  d: Database = db(),
  spaceId: string | null = null,
): { slug: string; definition: WorkflowDefinition }[] {
  return (
    d
      .query(
        `SELECT w.slug,v.definition FROM workflow w JOIN workflow_version v ON v.workflow_id=w.id
         WHERE v.status='production' AND w.space_id IS ? ORDER BY w.slug`,
      )
      .all(spaceId) as { slug: string; definition: string }[]
  ).map((row) => ({ slug: row.slug, definition: JSON.parse(row.definition) as WorkflowDefinition }))
}
export function showWorkflow(slug: string, n?: number, d: Database = db()) {
  return parseVersion(versionRow(slug, n, d))
}

export function showResolvedWorkflow(
  slug: string,
  n: number | undefined,
  project: string | null,
  d: Database = db(),
) {
  const spaceId = projectWorkflowResolutionSpace(d, project, slug, n)
  return parseVersion(versionRow(slug, n, d, spaceId))
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
type LocalWorkflowRow = ReturnType<typeof workflowLifecycle.write>
function hostedWorkflowRow(
  slug: string,
  n: number,
  d: Database,
  spaceId: string,
): LocalWorkflowRow {
  const row = selectedWorkflow(slug, n, d, spaceId)
  return { ...row, owner_id: row.workflow_id }
}
function writeDraftLocal(
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
export const setWorkflowLocal = (
  slug: string,
  definition: unknown,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) => writeDraftLocal(slug, definition, reason, author, 'set', d)
export const setWorkflow = (
  slug: string,
  definition: unknown,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) => {
  assertWorkflowWriteAllowed('set workflow')
  return hostedDraft('set', slug, definition, undefined, reason, author, d)
}

const writeAuthor = (value?: string) => value?.trim() || sessionId() || 'unknown'
async function hostedSpace(d: Database, project?: string) {
  const identity = await recordApiClient().whoami()
  const spaceId = project ? effectiveProjectSpace(d, project) : identity.activeSpaceId
  if (!spaceId) throw new Error('record session has no active space')
  return spaceId
}
const HOSTED_CATALOGUE_REFUSAL = `the hosted space has no production step catalogue; run \`${PLATFORM_SLUG} workflow catalogue set --file <path> --reason <reason>\` in that space, then promote it`
function hostedProductionCatalogue(d: Database, spaceId: string): StepCatalogueDefinition {
  try {
    return selectedStepCatalogue(undefined, d, spaceId).definition
  } catch {
    throw new Error(HOSTED_CATALOGUE_REFUSAL)
  }
}
function hostedDraft(
  kind: Extract<VersionEvent, 'set' | 'fork' | 'import'>,
  slug: string,
  definition: unknown,
  from: number | undefined,
  reason: string | undefined,
  author: string | undefined,
  d: Database,
  project?: string,
  knownCatalogue?: StepCatalogueDefinition,
) {
  requireSlug(slug)
  return applyRecordWriteAuthority({
    local: () => writeDraftLocal(slug, definition, reason, author, kind, d, knownCatalogue),
    hosted: async () => {
      if (!reason?.trim()) throw new Error('reason is required')
      const spaceId = await hostedSpace(d, project)
      requireValid(definition, undefined, hostedProductionCatalogue(d, spaceId))
      const result = await recordApiClient().draftWorkflow!(
        {
          kind: 'workflow',
          slug,
          event: kind,
          ...(kind === 'fork'
            ? { from: from ?? null }
            : { definition: JSON.stringify(definition) }),
          author: writeAuthor(author),
          reason: reason.trim(),
          sessionId: sessionId(),
        },
        { destinationSpaceId: spaceId },
      )
      await applyWorkflowWriteResponse(d, 'workflow', result)
      return hostedWorkflowRow(slug, result.versions.at(-1)!.n, d, spaceId)
    },
  })
}

export function promoteWorkflow(
  slug: string,
  n: number,
  reasonValue: string | undefined,
  authorValue?: string,
  d: Database = writableDb(),
) {
  assertWorkflowWriteAllowed('promote workflow')
  return applyRecordWriteAuthority({
    local: () => promoteWorkflowLocal(slug, n, reasonValue, authorValue, d),
    hosted: async () => {
      if (!reasonValue?.trim()) throw new Error('reason is required')
      const spaceId = await hostedSpace(d)
      const target = selectedWorkflow(slug, n, d, spaceId)
      workflowPromotionPreflight(slug, target.definition, d, spaceId)
      const current = d
        .query<{ n: number }, [string, string]>(
          `SELECT v.n FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? AND w.space_id=? AND v.status='production'`,
        )
        .get(slug, spaceId)
      const result = await recordApiClient().promoteWorkflow!(
        {
          kind: 'workflow',
          slug,
          n,
          expectedProductionVersion: current?.n ?? null,
          author: writeAuthor(authorValue),
          reason: reasonValue.trim(),
          sessionId: sessionId(),
        },
        { destinationSpaceId: spaceId },
      )
      await applyWorkflowWriteResponse(d, 'workflow', result)
      return hostedWorkflowRow(slug, n, d, spaceId)
    },
  })
}
export function promoteWorkflowLocal(
  slug: string,
  n: number,
  reasonValue: string | undefined,
  authorValue: string | undefined,
  d: Database = writableDb(),
) {
  // A draft is validated against the catalogue it was written for; the
  // production catalogue may have dropped one of its steps since.
  return workflowLifecycle.promote(slug, n, reasonValue, authorValue, d, (definition, database) => {
    workflowPromotionPreflight(slug, definition, database, null)
  })
}
export const retireWorkflowLocal = (
  slug: string,
  n: number,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) => workflowLifecycle.retire(slug, n, reason, author, d)
function workflowPromotionPreflight(
  slug: string,
  definition: WorkflowDefinition,
  d: Database,
  spaceId: string | null,
): void {
  const catalogue =
    spaceId === null ? productionStepCatalogue(d).definition : hostedProductionCatalogue(d, spaceId)
  requireValid(definition, undefined, catalogue)
  const refusal = catalogueReferenceRefusal(slug, definition, catalogue)
  if (refusal) throw new Error(refusal)
  const workflows = productionWorkflows(d, spaceId).filter((workflow) => workflow.slug !== slug)
  workflows.push({ slug, definition })
  const renderRefusal = renderCheckRefusal(
    checkWorkflowRendering(workflows, catalogue, projects(undefined, d)),
  )
  if (renderRefusal) throw new Error(renderRefusal)
}
export function retireWorkflow(
  slug: string,
  n: number,
  reasonValue: string | undefined,
  authorValue?: string,
  d: Database = writableDb(),
) {
  assertWorkflowWriteAllowed('retire workflow')
  return applyRecordWriteAuthority({
    local: () => workflowLifecycle.retire(slug, n, reasonValue, authorValue, d),
    hosted: async () => {
      if (!reasonValue?.trim()) throw new Error('reason is required')
      const spaceId = await hostedSpace(d)
      hostedProductionCatalogue(d, spaceId)
      const current = d
        .query<{ n: number }, [string, string]>(
          `SELECT v.n FROM workflow_version v JOIN workflow w ON w.id=v.workflow_id WHERE w.slug=? AND w.space_id=? AND v.status='production'`,
        )
        .get(slug, spaceId)
      const result = await recordApiClient().retireWorkflow!(
        {
          kind: 'workflow',
          slug,
          n,
          expectedProductionVersion: current?.n ?? null,
          author: writeAuthor(authorValue),
          reason: reasonValue.trim(),
          sessionId: sessionId(),
        },
        { destinationSpaceId: spaceId },
      )
      await applyWorkflowWriteResponse(d, 'workflow', result)
      return hostedWorkflowRow(slug, n, d, spaceId)
    },
  })
}
export function forkWorkflow(
  slug: string,
  from: number | undefined,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) {
  assertWorkflowWriteAllowed('fork workflow')
  return applyRecordWriteAuthority({
    local: () => {
      const definition = (
        from === undefined
          ? workflowLifecycle.production(slug, d)
          : workflowLifecycle.show(slug, from, d)
      ).definition
      return writeDraftLocal(slug, definition, reason, author, 'fork', d)
    },
    hosted: async () => {
      if (!reason?.trim()) throw new Error('reason is required')
      const spaceId = await hostedSpace(d)
      const catalogue = hostedProductionCatalogue(d, spaceId)
      requireValid(selectedWorkflow(slug, from, d, spaceId).definition, undefined, catalogue)
      const result = await recordApiClient().draftWorkflow!(
        {
          kind: 'workflow',
          slug,
          event: 'fork',
          from: from ?? null,
          author: writeAuthor(author),
          reason: reason.trim(),
          sessionId: sessionId(),
        },
        { destinationSpaceId: spaceId },
      )
      await applyWorkflowWriteResponse(d, 'workflow', result)
      return hostedWorkflowRow(slug, result.versions.at(-1)!.n, d, spaceId)
    },
  })
}
function forkWorkflowLocal(
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
  return writeDraftLocal(slug, definition, reason, author, 'fork', d)
}
export function resolvedWorkflowVersions(slug: string, project: string | null, d: Database = db()) {
  const spaceId = projectWorkflowResolutionSpace(d, project, slug)
  return workflowLifecycle.versions(slug, d, spaceId)
}

export function resolvedProductionWorkflows(project: string, d: Database = db()) {
  const spaceId = projectCatalogueResolutionSpace(d, project)
  return workflowSlugs(d, spaceId).flatMap((slug) => {
    const exists = d
      .query(
        `SELECT 1 FROM workflow w JOIN workflow_version v ON v.workflow_id=w.id
         WHERE w.slug=? AND w.space_id IS ? AND v.status='production'`,
      )
      .get(slug, spaceId)
    if (!exists) return []
    const row = parseVersion(productionVersionRow(slug, d, spaceId))
    return [{ slug, definition: row.definition, spaceId }]
  })
}

type WorkflowNeeds = {
  mode?: { slug: string; title: string; entry: string }[]
  arguments?: { name: string; description: string }[]
}
type WorkflowSelection = { version?: number; catalogueVersion?: number; mode?: string }

const selectedWorkflow = (
  slug: string,
  version: number | undefined,
  d: Database,
  spaceId: string | null = null,
) =>
  parseVersion(
    version === undefined
      ? productionVersionRow(slug, d, spaceId)
      : versionRow(slug, version, d, spaceId),
  )
const selectedCatalogue = (
  version: number | undefined,
  d: Database,
  spaceId: string | null = null,
) => selectedStepCatalogue(version, d, spaceId)

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

function workflowProject(projectName: string, d: Database) {
  const row = d
    .query('SELECT name,stack,settings FROM project WHERE name=? AND retired_at IS NULL')
    .get(projectName) as { name: string; stack: string | null; settings: string | null } | null
  if (!row) throw new Error(`unknown project "${projectName}"`)
  return { name: row.name, stack: row.stack, settings: JSON.parse(row.settings ?? '{}') }
}

export function composeWorkflow(
  slug: string,
  projectName: string,
  modeSlug?: string,
  args: Record<string, string> = {},
  d: Database = db(),
  selection: WorkflowSelection = {},
  autonomy?: WorkflowAutonomyResolution,
) {
  const spaceId = projectWorkflowResolutionSpace(d, projectName, slug, selection.version)
  const row = selectedWorkflow(slug, selection.version, d, spaceId),
    definition = row.definition,
    catalogue = selectedCatalogue(selection.catalogueVersion, d, spaceId)
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
  const project = workflowProject(projectName, d)
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
  autonomy?: WorkflowAutonomyResolution,
) {
  const spaceId = projectWorkflowResolutionSpace(d, projectName, slug, selection.version)
  const row = selectedWorkflow(slug, selection.version, d, spaceId),
    definition = row.definition,
    catalogue = selectedCatalogue(selection.catalogueVersion, d, spaceId),
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
  const project = workflowProject(projectName, d)
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
  project?: string,
) {
  assertWorkflowWriteAllowed('import workflow')
  required(reason, 'reason')
  return hostedDraft(
    'import',
    slug,
    definition,
    undefined,
    reason,
    author,
    d,
    project,
    knownCatalogue,
  )
}
export const importWorkflowLocal = (
  slug: string,
  definition: unknown,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
  knownCatalogue?: StepCatalogueDefinition,
) => writeDraftLocal(slug, definition, reason, author, 'import', d, knownCatalogue)

export const workflowLocalLifecycle = {
  set: setWorkflowLocal,
  promote: promoteWorkflowLocal,
  retire: retireWorkflowLocal,
  fork: forkWorkflowLocal,
  import: importWorkflowLocal,
}
