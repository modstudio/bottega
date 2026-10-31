import { expect, test } from 'bun:test'
import type { WorkflowTreeStore } from './workflow-tree.ts'
import { planWorkflowTreePromotion } from './workflow-tree-promotion.ts'

const workflow = { title: 'Flow', description: 'Flow.', arguments: [], modes: [] }
const step = {
  slug: 'step',
  title: 'Step',
  floor: [],
  job: null,
  autonomy: 'auto' as const,
  needs: [],
  body: '',
}
const production: WorkflowTreeStore = { steps: [], sequences: [], workflows: [] }

test('orders the matching catalogue before matching workflows and omits other drafts', () => {
  const tree: WorkflowTreeStore = {
    steps: [step],
    sequences: [],
    workflows: [{ slug: 'match', definition: workflow }],
  }
  expect(
    planWorkflowTreePromotion({
      tree,
      production,
      newestCatalogueDraft: { n: 2, definition: { steps: [step] } },
      newestWorkflowDrafts: new Map([
        ['match', { n: 3, definition: workflow }],
        ['other', { n: 4, definition: { ...workflow, title: 'Other' } }],
      ]),
    }),
  ).toEqual({
    promotions: [
      { kind: 'catalogue', n: 2 },
      { kind: 'workflow', slug: 'match', n: 3 },
    ],
    divergent: [],
  })
})

test('reports a tree item that matches neither production nor the newest draft', () => {
  expect(
    planWorkflowTreePromotion({
      tree: { ...production, workflows: [{ slug: 'drifted', definition: workflow }] },
      production,
      newestWorkflowDrafts: new Map([
        ['drifted', { n: 2, definition: { ...workflow, title: 'Draft' } }],
      ]),
    }),
  ).toEqual({
    promotions: [],
    divergent: [{ kind: 'workflow', slug: 'drifted' }],
  })
})
