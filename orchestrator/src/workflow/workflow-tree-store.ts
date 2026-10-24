// concern: workflow-tree-store
/** Owns production workflow-tree reads and validated draft imports. Must not know commands, filesystems, projects, runs, or transports. */
import type { Database } from 'bun:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, writableDb, writeTransaction } from '../database/db.ts'
import { workflowReadSpaceFor } from '../project-space.ts'
import { currentRecordWriteDecision } from '../record/record-write-authority.ts'
import {
  type CatalogueSequence,
  type CatalogueStep,
  importStepCatalogue,
  selectedStepCatalogue,
  stepCatalogueLocalLifecycle,
  validateStepCatalogue,
} from './step-catalogue.ts'
import type { WorkflowTreeStore } from './workflow-tree.ts'
import {
  importWorkflow,
  productionWorkflows,
  validateWorkflowDefinition,
  workflowLocalLifecycle,
} from './workflows.ts'

export function productionWorkflowTree(
  d: Database = db(),
  project: string | null = null,
): WorkflowTreeStore {
  const spaceId = workflowReadSpaceFor(d, project)
  const catalogue = selectedStepCatalogue(undefined, d, spaceId)
  return {
    steps: catalogue.definition.steps,
    sequences: catalogue.definition.sequences ?? [],
    workflows: productionWorkflows(d, spaceId),
  }
}

export const productionWorkflowTreeFor = (
  project: string | null,
  d: Database = db(),
): WorkflowTreeStore => productionWorkflowTree(d, project)

const same = (left: unknown, right: unknown) => isDeepStrictEqual(left, right)

function orderedSteps(imported: CatalogueStep[], production: CatalogueStep[]): CatalogueStep[] {
  const importedBySlug = new Map(imported.map((step) => [step.slug, step]))
  const existing = production.flatMap((step) => {
    const replacement = importedBySlug.get(step.slug)
    return replacement ? [replacement] : []
  })
  const existingSlugs = new Set(production.map((step) => step.slug))
  return [
    ...existing,
    ...imported
      .filter((step) => !existingSlugs.has(step.slug))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
  ]
}

function orderedSequences(
  imported: CatalogueSequence[],
  production: CatalogueSequence[],
): CatalogueSequence[] {
  const importedBySlug = new Map(imported.map((sequence) => [sequence.slug, sequence]))
  const existing = production.flatMap((sequence) => {
    const replacement = importedBySlug.get(sequence.slug)
    return replacement ? [replacement] : []
  })
  const existingSlugs = new Set(production.map((sequence) => sequence.slug))
  return [
    ...existing,
    ...imported
      .filter((sequence) => !existingSlugs.has(sequence.slug))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
  ]
}

export type WorkflowTreeImportResult = {
  catalogue: DraftOutcome
  workflowOutcomes: (DraftOutcome & { slug: string })[]
}

type DraftOutcome = { status: 'created'; n: number } | { status: 'no change' }

function missingProductionFlows(tree: WorkflowTreeStore, production: WorkflowTreeStore): string[] {
  const imported = new Set(tree.workflows.map(({ slug }) => slug))
  return production.workflows
    .map(({ slug }) => slug)
    .filter((slug) => !imported.has(slug))
    .sort()
}

function newestDefinitions(
  database: Database,
  spaceId: string | null,
): {
  catalogues: unknown[]
  workflows: Map<string, unknown[]>
} {
  const catalogueRows = database
    .query<{ definition: string; status: string }, [string | null]>(
      `SELECT v.definition,v.status FROM step_catalogue_version v
       JOIN step_catalogue c ON c.record_id=v.catalogue_record_id
       WHERE c.slug='shared' AND c.space_id IS ? AND v.status IN ('production','draft')
       ORDER BY v.status='draft' DESC,v.n DESC`,
    )
    .all(spaceId)
  const workflowRows = database
    .query<{ slug: string; definition: string; status: string; n: number }, [string | null]>(
      `SELECT w.slug,v.definition,v.status,v.n FROM workflow_version v
       JOIN workflow w ON w.record_id=v.workflow_record_id
       WHERE w.space_id IS ? AND v.status IN ('production','draft')
       ORDER BY w.slug,v.status='draft' DESC,v.n DESC`,
    )
    .all(spaceId)
  const workflows = new Map<string, unknown[]>()
  for (const row of workflowRows) {
    const definitions = workflows.get(row.slug) ?? []
    // Only production and the newest draft participate in no-change detection.
    if (row.status === 'production' || !definitions.length)
      definitions.push(JSON.parse(row.definition) as unknown)
    workflows.set(row.slug, definitions)
  }
  return {
    catalogues: catalogueRows
      .filter(
        (row, index) =>
          row.status === 'production' ||
          (row.status === 'draft' &&
            catalogueRows.findIndex((candidate) => candidate.status === 'draft') === index),
      )
      .map(({ definition }) => JSON.parse(definition) as unknown),
    workflows,
  }
}

function refusalReason(errors: string[], fallback: string): string {
  return errors.length ? errors.join('; ') : fallback
}

function invalidTreeRefusal(
  tree: WorkflowTreeStore,
  catalogueErrors: string[],
  workflowErrors: Map<string, string[]>,
  missingFlows: string[],
): Error {
  const fallback = 'another definition in this import failed validation'
  const lines = [
    `catalogue: refused — ${refusalReason(catalogueErrors, fallback)}`,
    ...tree.workflows.map(
      ({ slug }) => `${slug}: refused — ${refusalReason(workflowErrors.get(slug) ?? [], fallback)}`,
    ),
    ...missingFlows.map(
      (slug) =>
        `${slug}: refused — production flow is missing from the tree; run ${PLATFORM_SLUG} workflow retire ${slug}`,
    ),
  ]
  return new Error(`invalid workflow tree:\n${lines.map((line) => `- ${line}`).join('\n')}`)
}

function hostedWriteFailure(error: unknown, written: string[], pending: string[]): Error {
  const reason = error instanceof Error ? error.message : String(error)
  return new Error(
    [
      `hosted workflow import stopped: ${reason}`,
      `written drafts: ${written.length ? written.join(', ') : 'none'}`,
      `not written: ${pending.length ? pending.join(', ') : 'none'}`,
      `retry the same import; completed drafts are detected as no change`,
    ].join('\n'),
  )
}

class HostedCacheApplyFailure extends Error {}

function hostedCacheApplyFailure(
  error: unknown,
  item: string,
  written: string[],
  pending: string[],
) {
  const reason = error instanceof Error ? error.message : String(error)
  return new HostedCacheApplyFailure(
    hostedWriteFailure(
      new Error(
        `${item} written to the hosted record; local cache not updated; run ${PLATFORM_SLUG} record sync to refresh: ${reason}`,
      ),
      written,
      pending,
    ).message,
  )
}

type ImportPlan = {
  catalogue: { steps: CatalogueStep[]; sequences: CatalogueSequence[] }
  catalogueChanged: boolean
  workflowsToWrite: WorkflowTreeStore['workflows']
  noChangeWorkflows: (DraftOutcome & { slug: string })[]
}

function changedSlugs<T extends { slug: string }>(production: T[], imported: T[]): string[] {
  const before = new Map(production.map((item) => [item.slug, item]))
  const after = new Map(imported.map((item) => [item.slug, item]))
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((slug) => !same(before.get(slug), after.get(slug)))
    .sort()
}

function planWorkflowTreeImport(
  tree: WorkflowTreeStore,
  production: WorkflowTreeStore,
  existing: ReturnType<typeof newestDefinitions>,
): ImportPlan {
  const steps = orderedSteps(tree.steps, production.steps)
  const sequences = orderedSequences(tree.sequences, production.sequences)
  const catalogue = { steps, sequences }
  const catalogueErrors = validateStepCatalogue(catalogue)
  const workflowErrors = new Map(
    tree.workflows.map(({ slug, definition }) => [
      slug,
      validateWorkflowDefinition(definition, undefined, catalogue),
    ]),
  )
  const missingFlows = missingProductionFlows(tree, production)
  if (
    catalogueErrors.length ||
    missingFlows.length ||
    [...workflowErrors.values()].some((errors) => errors.length)
  )
    throw invalidTreeRefusal(tree, catalogueErrors, workflowErrors, missingFlows)

  const changedSteps = changedSlugs(production.steps, steps)
  const changedSequences = changedSlugs(production.sequences, sequences)
  const productionFlows = new Map(
    production.workflows.map(({ slug, definition }) => [slug, definition]),
  )
  const changedWorkflows = tree.workflows
    .filter(({ slug, definition }) => !same(productionFlows.get(slug), definition))
    .sort((a, b) => a.slug.localeCompare(b.slug))
  const workflowsToWrite = changedWorkflows.filter(
    ({ slug, definition }) =>
      !existing.workflows.get(slug)?.some((candidate) => same(candidate, definition)),
  )
  const toWrite = new Set(workflowsToWrite.map(({ slug }) => slug))
  return {
    catalogue,
    catalogueChanged:
      (changedSteps.length > 0 || changedSequences.length > 0) &&
      !existing.catalogues.some((definition) => same(definition, catalogue)),
    workflowsToWrite,
    noChangeWorkflows: tree.workflows
      .filter(({ slug }) => !toWrite.has(slug))
      .map(({ slug }) => ({ slug, status: 'no change' })),
  }
}

async function writeHostedImport(
  plan: ImportPlan,
  reason: string,
  author: string | undefined,
  database: Database,
  project: string | undefined,
): Promise<WorkflowTreeImportResult> {
  const pending = [
    ...(plan.catalogueChanged ? ['catalogue'] : []),
    ...plan.workflowsToWrite.map(({ slug }) => `workflow ${slug}`),
  ]
  const written: string[] = []
  let catalogue: DraftOutcome = { status: 'no change' }
  const workflows = [...plan.noChangeWorkflows]
  try {
    if (plan.catalogueChanged) {
      let hostedN: number | undefined
      const row = await importStepCatalogue(
        plan.catalogue,
        reason,
        author,
        database,
        project,
        (n) => {
          hostedN = n
          written.push(`catalogue draft ${n}`)
          pending.shift()
        },
      ).catch((error) => {
        if (hostedN !== undefined)
          throw hostedCacheApplyFailure(error, `catalogue draft ${hostedN}`, written, pending)
        throw error
      })
      catalogue = { status: 'created', n: row.n }
    }
    for (const { slug, definition } of plan.workflowsToWrite) {
      let hostedN: number | undefined
      const row = await importWorkflow(
        slug,
        definition,
        reason,
        author,
        database,
        plan.catalogue,
        project,
        (n) => {
          hostedN = n
          written.push(`workflow ${slug} draft ${n}`)
          pending.shift()
        },
      ).catch((error) => {
        if (hostedN !== undefined)
          throw hostedCacheApplyFailure(
            error,
            `workflow ${slug} draft ${hostedN}`,
            written,
            pending,
          )
        throw error
      })
      workflows.push({ slug, status: 'created', n: row.n })
    }
  } catch (error) {
    if (error instanceof HostedCacheApplyFailure) throw error
    throw hostedWriteFailure(error, written, pending)
  }
  return { catalogue, workflowOutcomes: workflows }
}

function writeLocalImport(
  plan: ImportPlan,
  reason: string,
  author: string | undefined,
  database: Database,
): WorkflowTreeImportResult {
  const catalogue: DraftOutcome = plan.catalogueChanged
    ? {
        status: 'created',
        n: stepCatalogueLocalLifecycle.import(plan.catalogue, reason, author, database).n,
      }
    : { status: 'no change' }
  const workflows = [
    ...plan.noChangeWorkflows,
    ...plan.workflowsToWrite.map(({ slug, definition }) => ({
      slug,
      status: 'created' as const,
      n: workflowLocalLifecycle.import(slug, definition, reason, author, database, plan.catalogue)
        .n,
    })),
  ]
  return { catalogue, workflowOutcomes: workflows }
}

export function importWorkflowTree(
  tree: WorkflowTreeStore,
  reason: string | undefined,
  author?: string,
  d?: Database,
  project?: string,
): WorkflowTreeImportResult | Promise<WorkflowTreeImportResult> {
  if (!reason?.trim()) throw new Error('reason is required')
  const database = d ?? writableDb()
  return writeTransaction(() => {
    const production = productionWorkflowTree(database, project ?? null)
    const spaceId = workflowReadSpaceFor(database, project ?? null)
    const plan = planWorkflowTreeImport(tree, production, newestDefinitions(database, spaceId))
    if (!plan.catalogueChanged && !plan.workflowsToWrite.length)
      return {
        catalogue: { status: 'no change' as const },
        workflowOutcomes: plan.noChangeWorkflows,
      }
    if (currentRecordWriteDecision(database) === 'hosted')
      return writeHostedImport(plan, reason, author, database, project)
    return writeLocalImport(plan, reason, author, database)
  }, database)
}
