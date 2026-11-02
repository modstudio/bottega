import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { CatalogueStep } from './step-catalogue.ts'
import {
  planWorkflowHydration,
  type WorkflowTreeFile,
  type WorkflowTreeHistory,
  type WorkflowTreeStore,
} from './workflow-tree.ts'
import {
  decideWorkflowHydration,
  workflowHydrationProtectionLines,
} from './workflow-tree-hydration.ts'

const step = (slug: string, body: string): CatalogueStep => ({
  slug,
  title: slug,
  stage: 'implement',
  floor: [],
  body,
  job: null,
  autonomy: 'auto',
  needs: [],
})

const production: WorkflowTreeStore = {
  steps: [step('acceptance', 'current acceptance'), step('design', 'current design')],
  sequences: [],
  workflows: [],
}
const oldAcceptance = step('acceptance', 'old acceptance')
const history: WorkflowTreeHistory = {
  steps: new Map([['acceptance', [{ n: 1, value: oldAcceptance }]]]),
  sequences: new Map(),
  workflows: new Map(),
}

function branchTree(): WorkflowTreeFile[] {
  const oldStore = { ...production, steps: [oldAcceptance, production.steps[1]!] }
  const tree = planWorkflowHydration({ store: oldStore, tree: [] }).writes
  const design = tree.find(({ path }) => path.endsWith('/design.md'))!
  design.body = design.body.replace('current design', 'unimported design edit')
  tree.push({
    path: '.agents/workflow-steps/branch-new.md',
    body: '---\ntitle: Branch new\nfloor: []\njob: null\nautonomy: auto\nneeds: []\n---\nBranch-added step.\n',
  })
  return tree
}

const applyInMemory = (
  tree: WorkflowTreeFile[],
  decision: ReturnType<typeof decideWorkflowHydration>,
) => {
  const result = new Map(tree.map((file) => [file.path, file.body]))
  for (const path of decision.plan.deletes) result.delete(path)
  for (const file of decision.plan.writes) result.set(file.path, file.body)
  return result
}

describe('decideWorkflowHydration', () => {
  test('refreshes stale files and protects unimported edits and additions with both remedies', () => {
    const tree = branchTree()
    const before = new Map(tree.map((file) => [file.path, file.body]))
    const decision = decideWorkflowHydration({ production, draft: production, history, tree })
    const after = applyInMemory(tree, decision)

    expect(decision.plan.writes.map(({ path }) => path)).toEqual([
      '.agents/workflow-steps/acceptance.md',
    ])
    expect(decision.protected).toEqual([
      '.agents/workflow-steps/branch-new.md',
      '.agents/workflow-steps/design.md',
    ])
    expect(after.get('.agents/workflow-steps/acceptance.md')).not.toBe(
      before.get('.agents/workflow-steps/acceptance.md'),
    )
    for (const path of decision.protected) expect(after.get(path)).toBe(before.get(path))
    expect(workflowHydrationProtectionLines(decision.protected)).toEqual([
      'protect .agents/workflow-steps/branch-new.md: matches no production version',
      `  keep: ${PLATFORM_SLUG} workflow import --cwd <tree> --reason "<why>"`,
      `  discard: ${PLATFORM_SLUG} workflow hydrate --cwd <tree> --discard .agents/workflow-steps/branch-new.md`,
      'protect .agents/workflow-steps/design.md: matches no production version',
      `  keep: ${PLATFORM_SLUG} workflow import --cwd <tree> --reason "<why>"`,
      `  discard: ${PLATFORM_SLUG} workflow hydrate --cwd <tree> --discard .agents/workflow-steps/design.md`,
    ])
  })

  test('--discard overwrites exactly the named unimported path', () => {
    const tree = branchTree()
    const decision = decideWorkflowHydration({
      production,
      draft: production,
      history,
      tree,
      paths: new Set(['.agents/workflow-steps/design.md']),
      discard: new Set(['.agents/workflow-steps/design.md']),
    })
    expect(decision.plan.writes.map(({ path }) => path)).toEqual([
      '.agents/workflow-steps/design.md',
    ])
    expect(decision.plan.deletes).toEqual([])
    expect(decision.protected).toEqual([])
  })

  test('a stale file absent from current production may be deleted', () => {
    const tree = planWorkflowHydration({
      store: { steps: [oldAcceptance], sequences: [], workflows: [] },
      tree: [],
    }).writes
    const decision = decideWorkflowHydration({
      production: { steps: [], sequences: [], workflows: [] },
      draft: { steps: [], sequences: [], workflows: [] },
      history,
      tree,
    })
    expect(decision.plan.deletes).toEqual(['.agents/workflow-steps/acceptance.md'])
    expect(decision.protected).toEqual([])
  })

  test('refreshes stale files beside a drafted file without reporting or changing the draft', () => {
    const tree = branchTree()
    const designPath = '.agents/workflow-steps/design.md'
    const draftedDesign = step('design', 'unimported design edit')
    const before = tree.find(({ path }) => path === designPath)!.body
    const decision = decideWorkflowHydration({
      production,
      draft: { ...production, steps: [production.steps[0]!, draftedDesign] },
      history,
      tree,
    })
    const after = applyInMemory(tree, decision)

    expect(decision.plan.writes.map(({ path }) => path)).toEqual([
      '.agents/workflow-steps/acceptance.md',
    ])
    expect(decision.protected).toEqual(['.agents/workflow-steps/branch-new.md'])
    expect(after.get(designPath)).toBe(before)
  })

  test('reports selectors absent from both the collected and production trees', () => {
    const decision = decideWorkflowHydration({
      production,
      draft: production,
      history,
      tree: branchTree(),
      paths: new Set(['.agents/workflow-steps/missing.md']),
      discard: new Set(['.agents/workflows/also-missing.md']),
    })
    expect(decision.unknownSelectors).toEqual([
      { option: '--path', path: '.agents/workflow-steps/missing.md' },
      { option: '--discard', path: '.agents/workflows/also-missing.md' },
    ])
  })
})
