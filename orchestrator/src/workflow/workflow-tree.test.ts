import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkflowTreeStore } from './workflow-tree.ts'
import { parseWorkflowTree, planWorkflowHydration } from './workflow-tree.ts'
import { collectWorkflowTree } from './workflow-tree-files.ts'

const store: WorkflowTreeStore = {
  sequences: [{ slug: 'quality', title: 'Quality', steps: ['verify'] }],
  steps: [
    {
      slug: 'verify',
      title: 'Verify',
      stage: 'implement',
      floor: ['command-exit'],
      job: null,
      autonomy: 'auto',
      needs: ['docs'],
      body: 'Run the gate.',
    },
  ],
  workflows: [
    {
      slug: 'flow',
      definition: {
        title: 'Ship',
        description: 'Ship the change.',
        defaultPreset: 'autonomous',
        arguments: [
          { name: 'key', required: true, description: 'Task key.' },
          { name: 'branch', required: false, description: 'Existing branch.' },
        ],
        modes: [
          {
            slug: 'default',
            title: 'Ship',
            default: true,
            requires: ['branch'],
            steps: ['verify'],
          },
        ],
      },
    },
  ],
}

describe('planWorkflowHydration', () => {
  test('writes every production row into an empty tree and the resulting tree is stable', () => {
    const first = planWorkflowHydration({ store, tree: [] })
    expect(first.writes.map(({ path }) => path)).toEqual([
      '.agents/workflow-sequences/quality.md',
      '.agents/workflow-steps/verify.md',
      '.agents/workflows/flow.md',
    ])
    expect(planWorkflowHydration({ store, tree: first.writes })).toEqual({
      writes: [],
      deletes: [],
    })
    expect(parseWorkflowTree(first.writes)).toEqual(store)
  })

  test('deletes a tree file whose slug is absent from production', () => {
    expect(
      planWorkflowHydration({
        store,
        tree: [{ path: '.agents/workflow-steps/obsolete.md', body: 'old' }],
      }).deletes,
    ).toEqual(['.agents/workflow-steps/obsolete.md'])
  })

  test('reports drift in a changed sequence file', () => {
    const rendered = planWorkflowHydration({ store, tree: [] }).writes
    const changed = rendered.map((file) =>
      file.path === '.agents/workflow-sequences/quality.md'
        ? { ...file, body: file.body.replace('title: Quality', 'title: Changed') }
        : file,
    )
    expect(planWorkflowHydration({ store, tree: changed }).writes.map(({ path }) => path)).toEqual([
      '.agents/workflow-sequences/quality.md',
    ])
  })

  test('README.md in steps is neither parsed nor deleted and is refused at collection', () => {
    const tree = [{ path: '.agents/workflow-steps/README.md', body: 'notes\n' }]
    expect(parseWorkflowTree(tree)).toEqual({ steps: [], sequences: [], workflows: [] })
    expect(planWorkflowHydration({ store, tree }).deletes).toEqual([])
    const root = mkdtempSync(join(tmpdir(), 'orch-workflow-tree-readme-'))
    try {
      mkdirSync(join(root, '.agents', 'workflow-steps'), { recursive: true })
      writeFileSync(join(root, '.agents', 'workflow-steps', 'README.md'), 'notes\n')
      expect(() => collectWorkflowTree(root)).toThrow(
        `refusing ${join(root, '.agents', 'workflow-steps', 'README.md')}: not a workflow tree file`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
