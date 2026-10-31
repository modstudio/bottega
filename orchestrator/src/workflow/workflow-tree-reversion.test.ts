import { describe, expect, test } from 'bun:test'
import type { WorkflowTreeStore } from './workflow-tree.ts'
import { type WorkflowTreeHistory, workflowTreeReversions } from './workflow-tree-store.ts'

const step = (title: string) => ({
  slug: 'build',
  title,
  floor: [],
  body: title,
  job: null,
  autonomy: 'auto' as const,
  needs: [],
})
const workflow = (title: string) => ({
  slug: 'ship',
  definition: { title, description: title, arguments: [], modes: [] },
})
const productionTree: WorkflowTreeStore = {
  steps: [step('current')],
  sequences: [],
  workflows: [workflow('current')],
}
const history: WorkflowTreeHistory = {
  steps: new Map([['build', [{ n: 4, value: step('older') }]]]),
  sequences: new Map(),
  workflows: new Map([['ship', [{ n: 2, value: workflow('older').definition }]]]),
}
const decide = (tree: WorkflowTreeStore, changed: string[] = []) =>
  workflowTreeReversions({
    tree,
    production: {
      tree: productionTree,
      catalogueVersion: 5,
      workflowVersions: new Map([['ship', 3]]),
    },
    history,
    branchChangedPaths: new Set(changed),
  })

describe('workflowTreeReversions', () => {
  test('finds an untouched step matching an older production catalogue', () => {
    expect(decide({ ...productionTree, steps: [step('older')] })).toEqual([
      expect.objectContaining({
        kind: 'step',
        slug: 'build',
        matchedVersion: 4,
        productionVersion: 5,
      }),
    ])
  })

  test('allows an older step when its branch file changed', () => {
    expect(
      decide({ ...productionTree, steps: [step('older')] }, ['.agents/workflow-steps/build.md']),
    ).toEqual([])
  })

  test('allows a tree matching current production', () => {
    expect(decide(productionTree)).toEqual([])
  })

  test('finds an untouched workflow matching an older production version', () => {
    expect(decide({ ...productionTree, workflows: [workflow('older')] })).toEqual([
      expect.objectContaining({
        kind: 'workflow',
        slug: 'ship',
        matchedVersion: 2,
        productionVersion: 3,
      }),
    ])
  })
})
