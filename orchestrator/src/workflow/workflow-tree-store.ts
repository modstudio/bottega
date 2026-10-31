// concern: workflow-tree-store
/** Owns production workflow-tree reads and validated draft imports. Must not know commands, filesystems, projects, runs, or transports. */
import type { Database } from 'bun:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, writableDb, writeTransaction } from '../database/db.ts'
import { currentRecordWriteDecision } from '../record/record-write-authority.ts'
import {
  type CatalogueSequence,
  type CatalogueStep,
  importStepCatalogue,
  importStepCatalogueWithUnknownNeedsLocal,
  promoteStepCatalogue,
  type StepCatalogueDefinition,
  selectedStepCatalogue,
  stepCatalogueLocalLifecycle,
  unknownWorkflowFactNeeds,
  validateStepCatalogue,
} from './step-catalogue.ts'
import { workflowReadSpaceFor } from './workflow-read-space.ts'
import {
  treePath,
  WORKFLOW_TREE_FOLDERS,
  type WorkflowTreeFolder,
  type WorkflowTreeStore,
} from './workflow-tree.ts'
import { planWorkflowTreePromotion, type WorkflowTreePromotion } from './workflow-tree-promotion.ts'
import {
  importWorkflow,
  productionWorkflows,
  promoteWorkflow,
  validateWorkflowDefinition,
  type WorkflowDefinition,
  workflowLocalLifecycle,
} from './workflows.ts'

type VersionedDefinition = { n: number; value: unknown }
export type WorkflowTreeProduction = {
  tree: WorkflowTreeStore
  catalogueVersion: number
  workflowVersions: Map<string, number>
}
export type WorkflowTreeHistory = {
  steps: Map<string, VersionedDefinition[]>
  sequences: Map<string, VersionedDefinition[]>
  workflows: Map<string, VersionedDefinition[]>
}
export type WorkflowTreeReversion = {
  kind: 'step' | 'sequence' | 'workflow'
  slug: string
  path: string
  matchedVersion: number
  productionVersion: number
}

const TREE_FOLDER_BY_KIND: Record<WorkflowTreeReversion['kind'], WorkflowTreeFolder> = {
  sequence: WORKFLOW_TREE_FOLDERS[0],
  step: WORKFLOW_TREE_FOLDERS[1],
  workflow: WORKFLOW_TREE_FOLDERS[2],
}

const pathFor = (kind: WorkflowTreeReversion['kind'], slug: string) =>
  treePath(TREE_FOLDER_BY_KIND[kind], slug)

function matchingReversions(
  kind: WorkflowTreeReversion['kind'],
  imported: { slug: string; value: unknown }[],
  production: { slug: string; value: unknown; n: number }[],
  history: Map<string, VersionedDefinition[]>,
  branchChangedPaths: ReadonlySet<string>,
): WorkflowTreeReversion[] {
  const current = new Map(production.map((item) => [item.slug, item]))
  return imported.flatMap(({ slug, value }) => {
    const path = pathFor(kind, slug)
    const present = current.get(slug)
    if (!present || same(value, present.value) || branchChangedPaths.has(path)) return []
    const match = history.get(slug)?.find((candidate) => same(value, candidate.value))
    return match
      ? [{ kind, slug, path, matchedVersion: match.n, productionVersion: present.n }]
      : []
  })
}

export function workflowTreeReversions(input: {
  tree: WorkflowTreeStore
  production: WorkflowTreeProduction
  history: WorkflowTreeHistory
  branchChangedPaths: ReadonlySet<string>
}): WorkflowTreeReversion[] {
  const catalogueN = input.production.catalogueVersion
  return [
    ...matchingReversions(
      'step',
      input.tree.steps.map((value) => ({ slug: value.slug, value })),
      input.production.tree.steps.map((value) => ({ slug: value.slug, value, n: catalogueN })),
      input.history.steps,
      input.branchChangedPaths,
    ),
    ...matchingReversions(
      'sequence',
      input.tree.sequences.map((value) => ({ slug: value.slug, value })),
      input.production.tree.sequences.map((value) => ({ slug: value.slug, value, n: catalogueN })),
      input.history.sequences,
      input.branchChangedPaths,
    ),
    ...matchingReversions(
      'workflow',
      input.tree.workflows.map(({ slug, definition: value }) => ({ slug, value })),
      input.production.tree.workflows.map(({ slug, definition: value }) => ({
        slug,
        value,
        n: input.production.workflowVersions.get(slug)!,
      })),
      input.history.workflows,
      input.branchChangedPaths,
    ),
  ].sort((left, right) => left.path.localeCompare(right.path))
}

export function productionWorkflowTree(
  input: { database?: Database; project?: string | null } = {},
): WorkflowTreeStore {
  const database = input.database ?? db()
  const spaceId = workflowReadSpaceFor(database, input.project ?? null)
  const catalogue = selectedStepCatalogue(undefined, database, spaceId)
  return {
    steps: catalogue.definition.steps,
    sequences: catalogue.definition.sequences ?? [],
    workflows: productionWorkflows(database, spaceId),
  }
}

export function newestDraftWorkflowTree(
  input: { database?: Database; project?: string | null } = {},
): WorkflowTreeStore {
  const database = input.database ?? db()
  const spaceId = workflowReadSpaceFor(database, input.project ?? null)
  const production = productionWorkflowTree({ database, project: input.project ?? null })
  const catalogueDraft = database
    .query<{ definition: string }, [string | null]>(
      `SELECT v.definition FROM step_catalogue_version v
       JOIN step_catalogue c ON c.record_id=v.catalogue_record_id
       WHERE c.slug='shared' AND c.space_id IS ? AND v.status='draft' AND v.superseded_at IS NULL
       ORDER BY v.n DESC LIMIT 1`,
    )
    .get(spaceId)
  const catalogue = catalogueDraft
    ? (JSON.parse(catalogueDraft.definition) as StepCatalogueDefinition)
    : { steps: production.steps, sequences: production.sequences }
  const drafts = database
    .query<{ slug: string; definition: string }, [string | null]>(
      `SELECT w.slug,v.definition FROM workflow_version v
       JOIN workflow w ON w.record_id=v.workflow_record_id
       WHERE w.space_id IS ? AND v.status='draft' AND v.superseded_at IS NULL
         AND v.n=(SELECT MAX(v2.n) FROM workflow_version v2
           WHERE v2.workflow_record_id=v.workflow_record_id AND v2.status='draft' AND v2.superseded_at IS NULL)
       ORDER BY w.slug`,
    )
    .all(spaceId)
  const workflows = new Map(production.workflows.map((item) => [item.slug, item.definition]))
  for (const row of drafts)
    workflows.set(row.slug, JSON.parse(row.definition) as WorkflowDefinition)
  return {
    steps: catalogue.steps,
    sequences: catalogue.sequences ?? [],
    workflows: [...workflows].map(([slug, definition]) => ({ slug, definition })),
  }
}

export async function promoteMatchingWorkflowTreeDrafts(input: {
  tree: WorkflowTreeStore
  reason: string
  author?: string
  database?: Database
  project?: string | null
}): Promise<WorkflowTreePromotion[]> {
  const database = input.database ?? writableDb()
  const spaceId = workflowReadSpaceFor(database, input.project ?? null)
  const catalogueRow = database
    .query<{ n: number; definition: string }, [string | null]>(
      `SELECT v.n,v.definition FROM step_catalogue_version v
       JOIN step_catalogue c ON c.record_id=v.catalogue_record_id
       WHERE c.slug='shared' AND c.space_id IS ? AND v.status='draft' AND v.superseded_at IS NULL
       ORDER BY v.n DESC LIMIT 1`,
    )
    .get(spaceId)
  const workflowRows = database
    .query<{ slug: string; n: number; definition: string }, [string | null]>(
      `SELECT w.slug,v.n,v.definition FROM workflow_version v
       JOIN workflow w ON w.record_id=v.workflow_record_id
       WHERE w.space_id IS ? AND v.status='draft' AND v.superseded_at IS NULL
         AND v.n=(SELECT MAX(v2.n) FROM workflow_version v2
           WHERE v2.workflow_record_id=v.workflow_record_id AND v2.status='draft' AND v2.superseded_at IS NULL)`,
    )
    .all(spaceId)
  const plan = planWorkflowTreePromotion({
    tree: input.tree,
    production: productionWorkflowTree({ database, project: input.project ?? null }),
    ...(catalogueRow
      ? {
          newestCatalogueDraft: {
            n: catalogueRow.n,
            definition: JSON.parse(catalogueRow.definition) as StepCatalogueDefinition,
          },
        }
      : {}),
    newestWorkflowDrafts: new Map(
      workflowRows.map((row) => [
        row.slug,
        { n: row.n, definition: JSON.parse(row.definition) as WorkflowDefinition },
      ]),
    ),
  })
  for (const item of plan) {
    if (item.kind === 'catalogue')
      await promoteStepCatalogue(item.n, input.reason, input.author, database)
    else await promoteWorkflow(item.slug, item.n, input.reason, input.author, database)
  }
  return plan
}

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
  warnings?: { step: string; source: string }[]
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
         AND v.superseded_at IS NULL
       ORDER BY v.status='draft' DESC,v.n DESC`,
    )
    .all(spaceId)
  const workflowRows = database
    .query<{ slug: string; definition: string; status: string; n: number }, [string | null]>(
      `SELECT w.slug,v.definition,v.status,v.n FROM workflow_version v
       JOIN workflow w ON w.record_id=v.workflow_record_id
       WHERE w.space_id IS ? AND v.status IN ('production','draft')
         AND v.superseded_at IS NULL
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

function appendVersion(
  target: Map<string, VersionedDefinition[]>,
  slug: string,
  version: VersionedDefinition,
) {
  target.set(slug, [...(target.get(slug) ?? []), version])
}

function productionHistory(
  database: Database,
  spaceId: string | null,
): {
  catalogueVersion: number
  workflowVersions: Map<string, number>
  history: WorkflowTreeHistory
} {
  const catalogues = database
    .query<{ n: number; definition: string; status: string }, [string | null]>(
      `SELECT v.n,v.definition,v.status FROM step_catalogue_version v
       JOIN step_catalogue c ON c.record_id=v.catalogue_record_id
       WHERE c.slug='shared' AND c.space_id IS ? AND v.promoted_at IS NOT NULL
       ORDER BY v.n DESC`,
    )
    .all(spaceId)
  const workflows = database
    .query<{ slug: string; n: number; definition: string; status: string }, [string | null]>(
      `SELECT w.slug,v.n,v.definition,v.status FROM workflow_version v
       JOIN workflow w ON w.record_id=v.workflow_record_id
       WHERE w.space_id IS ? AND v.promoted_at IS NOT NULL
       ORDER BY w.slug,v.n DESC`,
    )
    .all(spaceId)
  const currentCatalogue = catalogues.find(({ status }) => status === 'production')
  if (!currentCatalogue) throw new Error('cannot read current production catalogue version')
  const history: WorkflowTreeHistory = {
    steps: new Map(),
    sequences: new Map(),
    workflows: new Map(),
  }
  for (const row of catalogues.filter(({ n }) => n !== currentCatalogue.n)) {
    const definition = JSON.parse(row.definition) as {
      steps: CatalogueStep[]
      sequences?: CatalogueSequence[]
    }
    for (const value of definition.steps)
      appendVersion(history.steps, value.slug, { n: row.n, value })
    for (const value of definition.sequences ?? [])
      appendVersion(history.sequences, value.slug, { n: row.n, value })
  }
  const workflowVersions = new Map<string, number>()
  for (const row of workflows) {
    if (row.status === 'production') workflowVersions.set(row.slug, row.n)
    else
      appendVersion(history.workflows, row.slug, {
        n: row.n,
        value: JSON.parse(row.definition) as unknown,
      })
  }
  return { catalogueVersion: currentCatalogue.n, workflowVersions, history }
}

function staleReversionRefusal(
  tree: WorkflowTreeStore,
  production: WorkflowTreeStore,
  facts: ReturnType<typeof productionHistory>,
  branchChangedPaths: ReadonlySet<string>,
): Error | null {
  const reversions = workflowTreeReversions({
    tree,
    production: { tree: production, ...facts },
    history: facts.history,
    branchChangedPaths,
  })
  if (!reversions.length) return null
  return new Error(
    `refusing stale workflow tree reversion:\n${reversions
      .map(
        ({ kind, slug, matchedVersion, productionVersion }) =>
          `- ${kind} ${slug}: tree matches production version ${matchedVersion}; current production version is ${productionVersion}`,
      )
      .join(
        '\n',
      )}\nremedy: run ${PLATFORM_SLUG} workflow hydrate --cwd <tree>, then commit the hydrated files`,
  )
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
  warnings: { step: string; source: string }[]
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
  const unknownNeeds = unknownWorkflowFactNeeds(catalogue)
  const ignoredErrors = new Set(unknownNeeds.map(({ error }) => error))
  const catalogueErrors = validateStepCatalogue(catalogue).filter(
    (error) => !ignoredErrors.has(error),
  )
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
    warnings: unknownNeeds.map(({ step, source }) => ({ step, source })),
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
        plan.warnings.length > 0,
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
  return {
    catalogue,
    workflowOutcomes: workflows,
    ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
  }
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
        n: (plan.warnings.length
          ? importStepCatalogueWithUnknownNeedsLocal(plan.catalogue, reason, author, database)
          : stepCatalogueLocalLifecycle.import(plan.catalogue, reason, author, database)
        ).n,
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
  return {
    catalogue,
    workflowOutcomes: workflows,
    ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
  }
}

export function importWorkflowTree(
  tree: WorkflowTreeStore,
  reason: string | undefined,
  author?: string,
  d?: Database,
  project?: string,
  branchChangedPaths?: ReadonlySet<string>,
): WorkflowTreeImportResult | Promise<WorkflowTreeImportResult> {
  if (!reason?.trim()) throw new Error('reason is required')
  const database = d ?? writableDb()
  return writeTransaction(() => {
    const production = productionWorkflowTree({ database, project: project ?? null })
    const spaceId = workflowReadSpaceFor(database, project ?? null)
    if (branchChangedPaths) {
      const refusal = staleReversionRefusal(
        tree,
        production,
        productionHistory(database, spaceId),
        branchChangedPaths,
      )
      if (refusal) throw refusal
    }
    const plan = planWorkflowTreeImport(tree, production, newestDefinitions(database, spaceId))
    if (!plan.catalogueChanged && !plan.workflowsToWrite.length)
      return {
        catalogue: { status: 'no change' as const },
        workflowOutcomes: plan.noChangeWorkflows,
        ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
      }
    if (currentRecordWriteDecision(database) === 'hosted')
      return writeHostedImport(plan, reason, author, database, project)
    return writeLocalImport(plan, reason, author, database)
  }, database)
}
