import { describe, expect, test } from 'bun:test'
import type { WorkflowTreeStore } from './workflow-tree.ts'
import { planWorkflowHydration } from './workflow-tree.ts'

const store: WorkflowTreeStore = {
  steps: [
    {
      slug: 'verify',
      title: 'Verify',
      floor: ['command-exit'],
      job: null,
      autonomy: 'auto',
      needs: ['docs'],
      body: 'Run the gate.',
    },
  ],
  workflows: [
    {
      slug: 'ship',
      definition: {
        title: 'Ship',
        description: 'Ship the change.',
        arguments: [],
        modes: [{ slug: 'default', title: 'Ship', default: true, steps: ['verify'] }],
      },
    },
  ],
}

describe('planWorkflowHydration', () => {
  test('writes every production row into an empty tree and the resulting tree is stable', () => {
    const first = planWorkflowHydration({ store, tree: [] })
    expect(first.writes.map(({ path }) => path)).toEqual([
      'workflows/flows/ship.md',
      'workflows/steps/verify.md',
    ])
    expect(planWorkflowHydration({ store, tree: first.writes })).toEqual({
      writes: [],
      deletes: [],
    })
  })

  test('deletes a tree file whose slug is absent from production', () => {
    expect(
      planWorkflowHydration({
        store,
        tree: [{ path: 'workflows/steps/obsolete.md', body: 'old' }],
      }).deletes,
    ).toEqual(['workflows/steps/obsolete.md'])
  })
})
