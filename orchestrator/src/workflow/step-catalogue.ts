// concern: workflows
/** Owns the shared, versioned workflow-step catalogue. */
import type { Database } from 'bun:sqlite'
import { orchDoValueOptionNames } from '../commands/do-options.ts'
import { db, writableDb } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import { workflowFactSources } from '../project/project-injection.ts'
import { projects } from '../project/projects.ts'
import { type AutonomyValue, autonomyStages, autonomyValues } from './autonomy.ts'
import type {
  CatalogueSequence,
  CatalogueStep,
  FloorEntry,
  StepCatalogueDefinition,
} from './step-catalogue-definition.ts'
import { versionedLifecycle } from './versioned-lifecycle.ts'
import type { WorkflowDefinition, WorkflowModeStep } from './workflow-definition.ts'
import { type FloorKind, floorKinds, isFloorKind } from './workflow-floor.ts'
import { checkWorkflowRendering, renderCheckRefusal } from './workflow-render-check.ts'
import { inspectWorkflowSteps, validateCatalogueSequences } from './workflow-step-sequences.ts'

export type {
  CatalogueSequence,
  CatalogueStep,
  StepCatalogueDefinition,
} from './step-catalogue-definition.ts'
export type { FloorKind }

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function validateStepCatalogue(value: unknown): string[] {
  if (!object(value) || !Array.isArray(value.steps)) return ['steps must be an array']
  const errors: string[] = [],
    seen = new Set<string>()
  for (const [index, item] of value.steps.entries()) {
    if (!object(item)) {
      errors.push(`step ${index + 1} must be an object`)
      continue
    }
    validateIdentity(item, seen, errors)
    validateFloor(item, errors)
    validateNeeds(item, errors)
    validateDispatchPrompts(item, errors)
  }
  errors.push(
    ...validateCatalogueSequences(
      value.sequences,
      new Set(
        value.steps.flatMap((item) =>
          object(item) && typeof item.slug === 'string' ? [item.slug] : [],
        ),
      ),
    ),
  )
  return [...new Set(errors)]
}

function validateDispatchPrompts(item: Record<string, unknown>, errors: string[]): void {
  if (typeof item.body !== 'string') return
  const slug = String(item.slug ?? '')
  for (const match of item.body.matchAll(/`([^`\n]+)`/g)) {
    const command = match[1]!.trim()
    if (!/^(?:orch|\S*\/bin\/orch)\s+do\s+\S+/.test(command)) continue
    if (!dispatchHasPromptOrFile(command))
      errors.push(
        `step "${slug}" dispatch "${command}" must include --file or a double-quoted argument`,
      )
  }
}

type ShellToken = { value: string; quoted: boolean }

function shellTokens(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let value = '',
    quote: '"' | "'" | null = null,
    quoted = false,
    escaped = false
  const push = () => {
    if (value || quoted) tokens.push({ value, quoted })
    value = ''
    quoted = false
  }
  for (const character of command) {
    if (escaped) {
      value += character
      escaped = false
    } else if (character === '\\' && quote !== "'") escaped = true
    else if (quote) {
      if (character === quote) quote = null
      else value += character
    } else if (character === '"' || character === "'") {
      quote = character
      quoted = true
    } else if (/\s/.test(character)) push()
    else value += character
  }
  if (escaped) value += '\\'
  push()
  return tokens
}

function dispatchHasPromptOrFile(command: string): boolean {
  const tokens = shellTokens(command)
  let file = ''
  for (let index = 3; index < tokens.length; index++) {
    const token = tokens[index]!
    const option = consumeDispatchOption(tokens, index)
    if (option) {
      index = option.next
      if (option.file !== null) file = option.file
      continue
    }
    if (token.quoted && token.value.trim()) return true
  }
  return Boolean(file.trim())
}

function consumeDispatchOption(
  tokens: ShellToken[],
  index: number,
): { next: number; file: string | null } | null {
  const token = tokens[index]!
  if (!token.value.startsWith('--')) return null
  const [flag, inline] = token.value.slice(2).split('=', 2),
    valueKind = orchDoValueOptionNames.get(flag!)
  if (!valueKind) return { next: index, file: null }
  const following = tokens[index + 1],
    consumesFollowing =
      inline === undefined &&
      following !== undefined &&
      (valueKind === 'required' || !following.value.startsWith('--')),
    optionValue = inline ?? (consumesFollowing ? following?.value : undefined)
  return {
    next: consumesFollowing ? index + 1 : index,
    file: flag === 'file' ? (optionValue ?? '') : null,
  }
}

function validateIdentity(
  item: Record<string, unknown>,
  seen: Set<string>,
  errors: string[],
): void {
  const slug = typeof item.slug === 'string' ? item.slug : ''
  if (!SLUG.test(slug)) errors.push(`step slug "${slug}" is not well-formed`)
  if (seen.has(slug)) errors.push(`duplicate step slug "${slug}"`)
  seen.add(slug)
  if (typeof item.title !== 'string' || !item.title.trim())
    errors.push(`step "${slug}" title must be non-empty`)
  if (typeof item.body !== 'string') errors.push(`step "${slug}" body must be a string`)
  if (item.job !== null && (typeof item.job !== 'string' || !(item.job in JOBS)))
    errors.push(`step "${slug}" names unknown job "${String(item.job)}"`)
  if (!(autonomyValues as readonly string[]).includes(String(item.autonomy)))
    errors.push(`step "${slug}" has invalid autonomy "${String(item.autonomy)}"`)
  if (!(autonomyStages as readonly string[]).includes(String(item.stage)))
    errors.push(`step "${slug}" has invalid or missing stage "${String(item.stage)}"`)
}

/** Stored catalogue history remains readable without being revalidated. */
export function compatibleCatalogueStep(step: CatalogueStep): CatalogueStep {
  const legacy = step as unknown as Omit<CatalogueStep, 'autonomy' | 'floor'> & {
    autonomy: AutonomyValue | 'manual'
    floor: string[]
  }
  const floor: FloorEntry[] = []
  for (const kind of legacy.floor) {
    const mapped = kind === 'human-ruling' ? 'ruling' : kind
    if (isFloorKind(mapped) || isFloorPlaceholder(mapped)) floor.push(mapped)
  }
  return {
    ...step,
    autonomy: legacy.autonomy === 'manual' ? 'ask' : legacy.autonomy,
    floor,
  }
}

function validateDeferrable(
  item: Record<string, unknown>,
  floor: string[],
  errors: string[],
): void {
  const slug = String(item.slug ?? '')
  if (item.deferrable === undefined) return
  if (!Array.isArray(item.deferrable)) {
    errors.push(`step "${slug}" deferrable must be an array`)
    return
  }
  const deferrable = item.deferrable.map(String)
  if (new Set(deferrable).size !== deferrable.length)
    errors.push(`step "${slug}" deferrable has duplicates`)
  for (const kind of deferrable) {
    if (!floor.includes(kind))
      errors.push(`step "${slug}" deferrable kind "${kind}" is not on the floor`)
  }
}

function validateExpectedStatus(item: Record<string, unknown>, errors: string[]): void {
  if (item.expectedStatus === undefined) return
  const statuses = Array.isArray(item.expectedStatus) ? item.expectedStatus : [item.expectedStatus]
  if (
    statuses.length === 0 ||
    statuses.some((status) => typeof status !== 'string' || !status.trim())
  )
    errors.push(
      `step "${String(item.slug ?? '')}" expectedStatus must be a non-empty string or string list`,
    )
}

function validateFloor(item: Record<string, unknown>, errors: string[]): void {
  const slug = String(item.slug ?? '')
  if (!Array.isArray(item.floor) || item.floor.length === 0) {
    errors.push(`step "${slug}" floor must be non-empty`)
    return
  }
  const floor = item.floor.map(String)
  if (new Set(floor).size !== floor.length) errors.push(`step "${slug}" floor has duplicates`)
  const known = new Set<string>(floorKinds)
  for (const kind of floor)
    if (!known.has(kind) && !isFloorPlaceholder(kind))
      errors.push(`step "${slug}" has invalid floor kind "${kind}"`)
  validateDeferrable(item, floor, errors)
  if (item.requirePullRequest !== undefined && typeof item.requirePullRequest !== 'boolean')
    errors.push(`step "${slug}" requirePullRequest must be a boolean`)
  if (item.operatorRuling !== undefined && typeof item.operatorRuling !== 'boolean')
    errors.push(`step "${slug}" operatorRuling must be a boolean`)
  if (item.operatorRuling === true && !floor.includes('ruling') && !floor.some(isFloorPlaceholder))
    errors.push(`step "${slug}" operatorRuling requires a ruling floor`)
  validateCommandEvidence(item, floor, errors)
  validateExpectedStatus(item, errors)
}

function validateCommandEvidence(
  item: Record<string, unknown>,
  floor: string[],
  errors: string[],
): void {
  const slug = String(item.slug ?? '')
  if (item.commandEvidence !== undefined && item.commandEvidence !== 'gate')
    errors.push(`step "${slug}" commandEvidence must be "gate"`)
  if (
    item.commandEvidence === 'gate' &&
    !floor.includes('command-exit') &&
    !floor.some(isFloorPlaceholder)
  )
    errors.push(`step "${slug}" commandEvidence requires a command-exit floor`)
  if (
    item.commandEvidence === 'gate' &&
    Array.isArray(item.deferrable) &&
    item.deferrable.includes('command-exit')
  )
    errors.push(`step "${slug}" cannot defer command-exit when commandEvidence is "gate"`)
}

const isFloorPlaceholder = (value: string): value is `{{${string}}}` =>
  /^\{\{[^{}]+\}\}$/.test(value)

function validateNeeds(item: Record<string, unknown>, errors: string[]): void {
  const slug = String(item.slug ?? '')
  if (!Array.isArray(item.needs)) {
    errors.push(`step "${slug}" needs must be an array`)
    return
  }
  const needs = item.needs.map(String)
  if (new Set(needs).size !== needs.length) errors.push(`step "${slug}" needs has duplicates`)
  for (const source of needs)
    if (!(workflowFactSources as readonly string[]).includes(source))
      errors.push(`step "${slug}" has invalid injection source "${source}"`)
}

function requireCatalogue(value: unknown): asserts value is StepCatalogueDefinition {
  const errors = validateStepCatalogue(value)
  if (errors.length)
    throw new Error(`invalid step catalogue:\n${errors.map((error) => `- ${error}`).join('\n')}`)
}

const lifecycle = versionedLifecycle<StepCatalogueDefinition>({
  noun: 'step catalogue',
  identityTable: 'step_catalogue',
  versionTable: 'step_catalogue_version',
  eventTable: 'step_catalogue_event',
  foreignKey: 'catalogue_id',
  validate(value) {
    requireCatalogue(value)
  },
})
const CATALOGUE = 'shared'

const compatibleCatalogue = <T extends { definition: StepCatalogueDefinition }>(row: T): T => ({
  ...row,
  definition: {
    steps: row.definition.steps.map(compatibleCatalogueStep),
    ...(row.definition.sequences === undefined ? {} : { sequences: row.definition.sequences }),
  },
})
export const showStepCatalogue = (n?: number, d: Database = db()) =>
  compatibleCatalogue(lifecycle.show(CATALOGUE, n, d))
export const productionStepCatalogue = (d: Database = db()) =>
  compatibleCatalogue(lifecycle.production(CATALOGUE, d))
export const setStepCatalogue = (
  definition: unknown,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) => lifecycle.write(CATALOGUE, definition, reason, author, 'set', d)
export const forkStepCatalogue = (
  from: number | undefined,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) => {
  const source = from === undefined ? productionStepCatalogue(d) : showStepCatalogue(from, d)
  return lifecycle.write(CATALOGUE, source.definition, reason, author, 'fork', d)
}
export const retireStepCatalogue = (
  n: number,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) => lifecycle.retire(CATALOGUE, n, reason, author, d)
export const stepCatalogueVersions = (d: Database = db()) => lifecycle.versions(CATALOGUE, d)

type ProductionWorkflowDefinition = {
  modes?: { slug?: string; steps?: WorkflowModeStep[] }[]
  steps?: unknown[]
}

function catalogueModePromotionErrors(
  workflowSlug: string,
  mode: { slug?: string; steps?: WorkflowModeStep[] },
  available: ReadonlySet<string>,
  currentSequences: readonly CatalogueSequence[],
  proposedSequences: readonly CatalogueSequence[],
): string[] {
  const entries = mode.steps ?? []
  const current = inspectWorkflowSteps(entries, currentSequences, available)
  const errors = current.missingSteps.length
    ? [`${workflowSlug}: ${current.missingSteps.join(', ')}`]
    : []
  const proposed = inspectWorkflowSteps(entries, proposedSequences, available)
  if (proposed.missingSequences.length)
    errors.push(
      `${workflowSlug} mode ${mode.slug ?? ''}: sequence "${proposed.missingSequences[0]}" is absent from the catalogue; add and promote that sequence, or edit the workflow mode to remove the reference`,
    )
  else if (proposed.duplicateSteps.length)
    errors.push(
      `${workflowSlug} mode ${mode.slug ?? ''}: duplicate steps ${proposed.duplicateSteps.join(', ')}`,
    )
  return errors
}

function cataloguePromotionReferenceErrors(
  definition: StepCatalogueDefinition,
  currentSequences: readonly CatalogueSequence[],
  rows: { slug: string; definition: string }[],
): string[] {
  const available = new Set(definition.steps.map((step) => step.slug))
  const proposedSequences = definition.sequences ?? []
  return rows.flatMap((row) => {
    const workflow = JSON.parse(row.definition) as ProductionWorkflowDefinition
    if (workflow.steps) return [] // Legacy inline versions remain valid history and self-contained.
    return (workflow.modes ?? []).flatMap((mode) =>
      catalogueModePromotionErrors(row.slug, mode, available, currentSequences, proposedSequences),
    )
  })
}

export function promoteStepCatalogue(
  n: number,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) {
  return lifecycle.promote(CATALOGUE, n, reason, author, d, (definition, database) => {
    const currentSequences = productionStepCatalogue(database).definition.sequences ?? []
    const rows = database
      .query(
        `SELECT w.slug,v.definition FROM workflow w JOIN workflow_version v ON v.workflow_id=w.id WHERE v.status='production'`,
      )
      .all() as { slug: string; definition: string }[]
    const missing = cataloguePromotionReferenceErrors(definition, currentSequences, rows)
    const workflows = rows.map((row) => ({
      slug: row.slug,
      definition: JSON.parse(row.definition) as WorkflowDefinition,
    }))
    if (missing.length)
      throw new Error(
        `step catalogue changes references used by production workflows:\n${missing.map((line) => `- ${line}`).join('\n')}\nfix: keep the named sequences and reached steps, or promote workflow drafts that remove those references first`,
      )
    const refusal = renderCheckRefusal(
      checkWorkflowRendering(workflows, definition, projects(undefined, database)),
    )
    if (refusal) throw new Error(refusal)
  })
}

export function importStepCatalogue(
  definition: unknown,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) {
  return lifecycle.write(CATALOGUE, definition, reason, author, 'import', d)
}
