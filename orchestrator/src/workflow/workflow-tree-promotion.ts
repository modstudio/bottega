import { isDeepStrictEqual } from 'node:util'
import type { StepCatalogueDefinition } from './step-catalogue.ts'
import type { WorkflowTreeStore } from './workflow-tree.ts'
import type { WorkflowDefinition } from './workflows.ts'

type WorkflowTreePromotion =
  | { kind: 'catalogue'; n: number }
  | { kind: 'workflow'; slug: string; n: number }
type WorkflowTreeDivergence = { kind: 'catalogue' } | { kind: 'workflow'; slug: string }
export type WorkflowTreePromotionPlan = {
  promotions: WorkflowTreePromotion[]
  divergent: WorkflowTreeDivergence[]
}

const bySlug = <T extends { slug: string }>(items: T[]): T[] =>
  [...items].sort((left, right) => left.slug.localeCompare(right.slug))

const normalizedCatalogue = (catalogue: StepCatalogueDefinition) => ({
  steps: bySlug(catalogue.steps),
  sequences: bySlug(catalogue.sequences ?? []),
})

export function planWorkflowTreePromotion(input: {
  tree: WorkflowTreeStore
  production: WorkflowTreeStore
  newestCatalogueDraft?: { n: number; definition: StepCatalogueDefinition }
  newestWorkflowDrafts: Map<string, { n: number; definition: WorkflowDefinition }>
}): WorkflowTreePromotionPlan {
  const treeCatalogue = normalizedCatalogue({
    steps: input.tree.steps,
    sequences: input.tree.sequences,
  })
  const productionCatalogue = normalizedCatalogue({
    steps: input.production.steps,
    sequences: input.production.sequences,
  })
  const catalogue = input.newestCatalogueDraft
  const draftCatalogue = catalogue && normalizedCatalogue(catalogue.definition)
  const promotions: WorkflowTreePromotion[] = []
  const divergent: WorkflowTreeDivergence[] = []
  if (!isDeepStrictEqual(treeCatalogue, productionCatalogue)) {
    if (catalogue && isDeepStrictEqual(treeCatalogue, draftCatalogue))
      promotions.push({ kind: 'catalogue', n: catalogue.n })
    else divergent.push({ kind: 'catalogue' })
  }
  for (const { slug, definition } of input.tree.workflows) {
    const production = input.production.workflows.find((item) => item.slug === slug)?.definition
    if (isDeepStrictEqual(definition, production)) continue
    const draft = input.newestWorkflowDrafts.get(slug)
    if (draft && isDeepStrictEqual(definition, draft.definition))
      promotions.push({ kind: 'workflow', slug, n: draft.n })
    else divergent.push({ kind: 'workflow', slug })
  }
  return {
    promotions: [
      ...promotions.filter(({ kind }) => kind === 'catalogue'),
      ...promotions
        .filter(
          (item): item is Extract<WorkflowTreePromotion, { kind: 'workflow' }> =>
            item.kind === 'workflow',
        )
        .sort((left, right) => left.slug.localeCompare(right.slug)),
    ],
    divergent: divergent.sort((left, right) =>
      (left.kind === 'catalogue' ? '' : left.slug).localeCompare(
        right.kind === 'catalogue' ? '' : right.slug,
      ),
    ),
  }
}
