import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { WorkflowTreeStore } from './workflow-tree.ts'
import {
  planWorkflowTreePromotion,
  workflowTreePromotionRemedyLines,
} from './workflow-tree-promotion.ts'

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

const otherStep = { ...step, slug: 'other-step', title: 'Other step' }

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

test('promotes a catalogue whose tree and draft orders differ', () => {
  expect(
    planWorkflowTreePromotion({
      tree: { ...production, steps: [step, otherStep] },
      production,
      newestCatalogueDraft: { n: 2, definition: { steps: [otherStep, step] } },
      newestWorkflowDrafts: new Map(),
    }),
  ).toEqual({
    promotions: [{ kind: 'catalogue', n: 2 }],
    divergent: [],
  })
})

test('does nothing when only the tree and production catalogue orders differ', () => {
  expect(
    planWorkflowTreePromotion({
      tree: { ...production, steps: [step, otherStep] },
      production: { ...production, steps: [otherStep, step] },
      newestWorkflowDrafts: new Map(),
    }),
  ).toEqual({ promotions: [], divergent: [] })
})

test('reports a catalogue that matches neither production nor its newest draft', () => {
  expect(
    planWorkflowTreePromotion({
      tree: { ...production, steps: [step] },
      production,
      newestCatalogueDraft: { n: 2, definition: { steps: [otherStep] } },
      newestWorkflowDrafts: new Map(),
    }),
  ).toEqual({
    promotions: [],
    divergent: [{ kind: 'catalogue' }],
  })
})

test('reports when no workflow draft promotion can clear a catalogue reference', () => {
  expect(
    workflowTreePromotionRemedyLines(
      ['still-linked'],
      [{ kind: 'catalogue', n: 2 }],
      0,
      PLATFORM_SLUG,
    ),
  ).toEqual([
    'workflow still-linked still references the removed catalogue step; no promotion order clears it',
  ])
})

test('reports that promotion order does not clear other catalogue reference errors', () => {
  expect(
    workflowTreePromotionRemedyLines(
      ['drops-step'],
      [
        { kind: 'catalogue', n: 2 },
        { kind: 'workflow', slug: 'drops-step', n: 3 },
        { kind: 'workflow', slug: 'other-error', n: 4 },
      ],
      1,
      PLATFORM_SLUG,
    ),
  ).toEqual([
    'clear in order:',
    `${PLATFORM_SLUG} workflow promote drops-step 3`,
    `${PLATFORM_SLUG} workflow promote-tree`,
    'the other errors listed above are not cleared by promotion order and must be fixed in the workflow or catalogue',
  ])
})
