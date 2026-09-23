// concern: workflows
/** Owns the shared, versioned workflow-step catalogue. */
import type { Database } from 'bun:sqlite'
import { db, writableDb } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import { type InjectionSource, injectionSources } from '../project/project-injection.ts'
import {
  type AutonomyStage,
  type AutonomyValue,
  autonomyStages,
  autonomyValues,
} from './autonomy.ts'
import { versionedLifecycle } from './versioned-lifecycle.ts'

const proofKinds = ['command-exit', 'recorded-artifact', 'tracker-transition', 'ruling'] as const
type ProofKind = (typeof proofKinds)[number]
export type CatalogueStep = {
  slug: string
  title: string
  body: string
  floor: ProofKind[]
  job: string | null
  /** Optional only when reading a stored catalogue created before stages existed. */
  stage?: AutonomyStage
  autonomy: AutonomyValue
  needs: InjectionSource[]
}
type StepCatalogueDefinition = { steps: CatalogueStep[] }

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
  }
  return [...new Set(errors)]
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
  return {
    ...step,
    autonomy: legacy.autonomy === 'manual' ? 'ask' : legacy.autonomy,
    floor: legacy.floor.map((kind) =>
      kind === 'human-ruling' ? 'ruling' : kind,
    ) as CatalogueStep['floor'],
  }
}

function validateFloor(item: Record<string, unknown>, errors: string[]): void {
  const slug = String(item.slug ?? '')
  if (!Array.isArray(item.floor) || item.floor.length === 0) {
    errors.push(`step "${slug}" floor must be non-empty`)
    return
  }
  const floor = item.floor.map(String)
  if (new Set(floor).size !== floor.length) errors.push(`step "${slug}" floor has duplicates`)
  for (const kind of floor)
    if (!(proofKinds as readonly string[]).includes(kind))
      errors.push(`step "${slug}" has invalid proof kind "${kind}"`)
}

function validateNeeds(item: Record<string, unknown>, errors: string[]): void {
  const slug = String(item.slug ?? '')
  if (!Array.isArray(item.needs)) {
    errors.push(`step "${slug}" needs must be an array`)
    return
  }
  const needs = item.needs.map(String)
  if (new Set(needs).size !== needs.length) errors.push(`step "${slug}" needs has duplicates`)
  for (const source of needs)
    if (!(injectionSources as readonly string[]).includes(source))
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
  definition: { steps: row.definition.steps.map(compatibleCatalogueStep) },
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
  const source =
    from === undefined ? productionStepCatalogue(d) : showStepCatalogue(from, d)
  return lifecycle.write(CATALOGUE, source.definition, reason, author, 'fork', d)
}
export const retireStepCatalogue = (
  n: number,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) => lifecycle.retire(CATALOGUE, n, reason, author, d)
export const stepCatalogueVersions = (d: Database = db()) => lifecycle.versions(CATALOGUE, d)

export function promoteStepCatalogue(
  n: number,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) {
  return lifecycle.promote(CATALOGUE, n, reason, author, d, (definition, database) => {
    const available = new Set(definition.steps.map((step) => step.slug))
    const missing: string[] = []
    const rows = database
      .query(
        `SELECT w.slug,v.definition FROM workflow w JOIN workflow_version v ON v.workflow_id=w.id WHERE v.status='production'`,
      )
      .all() as { slug: string; definition: string }[]
    for (const row of rows) {
      const workflow = JSON.parse(row.definition) as {
        modes?: { steps?: string[] }[]
        steps?: unknown[]
      }
      if (workflow.steps) continue // Legacy inline versions remain valid history and self-contained.
      const absent = [...new Set(workflow.modes?.flatMap((mode) => mode.steps ?? []) ?? [])].filter(
        (slug) => !available.has(slug),
      )
      if (absent.length) missing.push(`${row.slug}: ${absent.join(', ')}`)
    }
    if (missing.length)
      throw new Error(
        `step catalogue drops steps used by production workflows:\n${missing.map((line) => `- ${line}`).join('\n')}`,
      )
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
