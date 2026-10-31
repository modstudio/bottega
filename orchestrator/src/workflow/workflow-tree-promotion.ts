import { isDeepStrictEqual } from 'node:util'
import type { StepCatalogueDefinition } from './step-catalogue.ts'
import type { WorkflowTreeStore } from './workflow-tree.ts'
import type { WorkflowDefinition } from './workflows.ts'

export type WorkflowTreePromotion =
  | { kind: 'catalogue'; n: number }
  | { kind: 'workflow'; slug: string; n: number }

export function planWorkflowTreePromotion(input: {
  tree: WorkflowTreeStore
  production: WorkflowTreeStore
  newestCatalogueDraft?: { n: number; definition: StepCatalogueDefinition }
  newestWorkflowDrafts: Map<string, { n: number; definition: WorkflowDefinition }>
}): WorkflowTreePromotion[] {
  const treeCatalogue = { steps: input.tree.steps, sequences: input.tree.sequences }
  const productionCatalogue = {
    steps: input.production.steps,
    sequences: input.production.sequences,
  }
  const catalogue = input.newestCatalogueDraft
  const draftCatalogue = catalogue && {
    steps: catalogue.definition.steps,
    sequences: catalogue.definition.sequences ?? [],
  }
  const workflows = input.tree.workflows.flatMap(({ slug, definition }) => {
    const draft = input.newestWorkflowDrafts.get(slug)
    return draft && isDeepStrictEqual(definition, draft.definition)
      ? [{ kind: 'workflow' as const, slug, n: draft.n }]
      : []
  })
  return [
    ...(catalogue &&
    isDeepStrictEqual(treeCatalogue, draftCatalogue) &&
    !isDeepStrictEqual(treeCatalogue, productionCatalogue)
      ? [{ kind: 'catalogue' as const, n: catalogue.n }]
      : []),
    ...workflows.sort((left, right) => left.slug.localeCompare(right.slug)),
  ]
}
