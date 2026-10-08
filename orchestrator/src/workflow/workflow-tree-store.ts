// concern: workflow-tree-store
/** Owns production workflow-tree reads and atomic draft imports. Must not know commands, filesystems, projects, runs, or transports. */
import type { Database } from 'bun:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { db, writableDb, writeTransaction } from '../database/db.ts'
import {
  type CatalogueSequence,
  type CatalogueStep,
  importStepCatalogue,
  productionStepCatalogue,
  validateStepCatalogue,
} from './step-catalogue.ts'
import type { WorkflowTreeStore } from './workflow-tree.ts'
import { importWorkflow, productionWorkflows, validateWorkflowDefinition } from './workflows.ts'

export function productionWorkflowTree(d: Database = db()): WorkflowTreeStore {
  return {
    steps: productionStepCatalogue(d).definition.steps,
    sequences: productionStepCatalogue(d).definition.sequences ?? [],
    workflows: productionWorkflows(d),
  }
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
  steps: string[]
  sequences: string[]
  workflows: string[]
}

function missingProductionFlows(tree: WorkflowTreeStore, production: WorkflowTreeStore): string[] {
  const imported = new Set(tree.workflows.map(({ slug }) => slug))
  return production.workflows
    .map(({ slug }) => slug)
    .filter((slug) => !imported.has(slug))
    .sort()
}

export function importWorkflowTree(
  tree: WorkflowTreeStore,
  reason: string | undefined,
  author?: string,
  d?: Database,
): WorkflowTreeImportResult {
  if (!reason?.trim()) throw new Error('reason is required')
  const database = d ?? writableDb()
  return writeTransaction(() => {
    const production = productionWorkflowTree(database)
    const missingFlows = missingProductionFlows(tree, production)
    if (missingFlows.length) {
      throw new Error(
        `refusing import: production flows missing from the tree:\n${missingFlows
          .map((slug) => `- ${slug}: orch workflow retire ${slug}`)
          .join('\n')}`,
      )
    }
    const steps = orderedSteps(tree.steps, production.steps)
    const sequences = orderedSequences(tree.sequences, production.sequences)
    const catalogue = { steps, sequences }
    const catalogueErrors = validateStepCatalogue(catalogue)
    const workflowErrors = tree.workflows.flatMap(({ slug, definition }) =>
      validateWorkflowDefinition(definition, database, catalogue).map(
        (error) => `workflow "${slug}": ${error}`,
      ),
    )
    const errors = [...catalogueErrors, ...workflowErrors]
    if (errors.length) {
      throw new Error(`invalid workflow tree:\n${errors.map((error) => `- ${error}`).join('\n')}`)
    }

    const productionSteps = new Map(production.steps.map((step) => [step.slug, step]))
    const importedSteps = new Map(steps.map((step) => [step.slug, step]))
    const changedSteps = [...new Set([...productionSteps.keys(), ...importedSteps.keys()])]
      .filter((slug) => !same(productionSteps.get(slug), importedSteps.get(slug)))
      .sort()
    const productionSequences = new Map(
      production.sequences.map((sequence) => [sequence.slug, sequence]),
    )
    const importedSequences = new Map(sequences.map((sequence) => [sequence.slug, sequence]))
    const changedSequences = [
      ...new Set([...productionSequences.keys(), ...importedSequences.keys()]),
    ]
      .filter((slug) => !same(productionSequences.get(slug), importedSequences.get(slug)))
      .sort()
    const productionFlows = new Map(
      production.workflows.map(({ slug, definition }) => [slug, definition]),
    )
    const changedWorkflows = tree.workflows
      .filter(({ slug, definition }) => !same(productionFlows.get(slug), definition))
      .sort((a, b) => a.slug.localeCompare(b.slug))

    if (!changedSteps.length && !changedSequences.length && !changedWorkflows.length)
      return { steps: [], sequences: [], workflows: [] }
    if (changedSteps.length || changedSequences.length)
      importStepCatalogue(catalogue, reason, author, database)
    for (const { slug, definition } of changedWorkflows) {
      importWorkflow(slug, definition, reason, author, database, catalogue)
    }
    return {
      steps: changedSteps,
      sequences: changedSequences,
      workflows: changedWorkflows.map(({ slug }) => slug),
    }
  }, database)
}
