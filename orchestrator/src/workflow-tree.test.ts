import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectWorkflowTree } from './workflow-tree-files.ts'
import type { WorkflowTreeStore } from './workflow-tree.ts'
import { parseWorkflowTree, planWorkflowHydration } from './workflow-tree.ts'

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

  test('README.md in steps is neither parsed nor deleted and is refused at collection', () => {
    const tree = [{ path: 'workflows/steps/README.md', body: 'notes\n' }]
    expect(parseWorkflowTree(tree)).toEqual({ steps: [], workflows: [] })
    expect(planWorkflowHydration({ store, tree }).deletes).toEqual([])
    const root = mkdtempSync(join(tmpdir(), 'orch-workflow-tree-readme-'))
    try {
      mkdirSync(join(root, 'workflows', 'steps'), { recursive: true })
      writeFileSync(join(root, 'workflows', 'steps', 'README.md'), 'notes\n')
      expect(() => collectWorkflowTree(root)).toThrow(
        `refusing ${join(root, 'workflows', 'steps', 'README.md')}: not a workflow tree file`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
